import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentTemplates } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { BRIEF_TEMPLATE } from './brief-template';
import type { TemplateKind, TemplateSection } from './constants';

export type TemplateView = {
  id: string;
  productId: string | null;
  kind: TemplateKind;
  name: string;
  body: string;
  sections: TemplateSection[];
  /** 模板说明（P3-C2），显示在编辑器上方；没有时为空字符串。 */
  guidance: string;
  active: boolean;
  updatedAt: Date;
};

const GUIDANCE_MAX = 2000;

/** 与旧 prd 系统一致的预置模板（变更记录 / 背景 / 产品概述 / 需求说明）。 */
export const PRESET_TEMPLATE: { name: string; body: string; sections: TemplateSection[] } = {
  name: '变更 PRD（预置）',
  body: `## 变更记录

| 日期 | 修订人 | 内容 |
|---|---|---|
| {{date}} | {{author}} | 初稿 |

## 1. 背景介绍

### 1.1 业务背景

简述本需求所处的业务背景、当前问题。

### 1.2 业务场景

| 场景 / 商业模式 | 商业价值 |
|---|---|
| 待填 | 待填 |

## 2. 产品概述

### 2.1 产品定位

一句话定位。

### 2.2 服务对象

- 角色 1
- 角色 2

### 2.3 信息架构

在此插入信息架构图（粘贴或拖入图片）。

### 2.4 角色术语

| 角色 | 定义 |
|---|---|
| 待填 | 待填 |

## 3. 需求说明

### 3.1 需求列表

| 序号 | 需求名称 | 优先级 | 状态 |
|---|---|---|---|
| R1 | 待填 | P0 | 待评审 |

### 3.2 需求明细

#### R1 · （需求名称）

**原型**：粘贴原型截图

**模块组成**：

**交互说明**：

**逻辑规则**：

**数据来源**：

**埋点需求**：
`,
  sections: [
    { heading: '变更记录', required: false, guidance: '每次修订追加一行：日期、修订人、内容' },
    { heading: '1. 背景介绍', required: true, guidance: '业务背景与业务场景' },
    { heading: '2. 产品概述', required: false, guidance: '定位、服务对象、信息架构、角色术语' },
    { heading: '3. 需求说明', required: true, guidance: '需求列表与逐条明细' },
  ],
};

const view = (r: typeof documentTemplates.$inferSelect): TemplateView => ({
  id: r.id,
  productId: r.productId,
  kind: r.kind === 'brief' ? 'brief' : 'change',
  name: r.name,
  body: r.body,
  sections: r.sections,
  guidance: r.guidance,
  active: r.active,
  updatedAt: r.updatedAt,
});

export async function insertPresetTemplate(tx: Tx, orgId: string): Promise<void> {
  await tx.insert(documentTemplates).values({ orgId, productId: null, kind: 'change', name: PRESET_TEMPLATE.name, body: PRESET_TEMPLATE.body, sections: PRESET_TEMPLATE.sections });
}

/** 预置简报模板（P3-C2）：新组织初始化时写入；已有组织由迁移 0022 补齐。 */
export async function insertPresetBriefTemplate(tx: Tx, orgId: string): Promise<void> {
  await tx.insert(documentTemplates).values({
    orgId,
    productId: null,
    kind: 'brief',
    name: BRIEF_TEMPLATE.name,
    body: BRIEF_TEMPLATE.body,
    sections: BRIEF_TEMPLATE.sections,
    guidance: BRIEF_TEMPLATE.guidance,
  });
}

function validate(input: { name: string; body: string; sections: TemplateSection[]; guidance: string }): {
  name: string;
  body: string;
  sections: TemplateSection[];
  guidance: string;
} {
  const name = input.name.trim();
  if (!name || name.length > 50) throw new AppError('invalid', '模板名称不能为空，且不超过 50 个字符');
  if (input.body.length > 50_000) throw new AppError('invalid', '模板正文不超过 50000 个字符');
  if (input.guidance.length > GUIDANCE_MAX) throw new AppError('invalid', `模板说明不超过 ${GUIDANCE_MAX} 个字符`);
  if (input.sections.length > 50) throw new AppError('invalid', '小节不超过 50 个');
  const sections = input.sections.map((s) => ({ heading: s.heading.trim(), required: s.required, ...(s.guidance?.trim() ? { guidance: s.guidance.trim() } : {}) }));
  if (sections.some((s) => !s.heading || s.heading.length > 100)) throw new AppError('invalid', '小节标题不能为空，且不超过 100 个字符');
  if (new Set(sections.map((s) => s.heading)).size !== sections.length) throw new AppError('invalid', '小节标题不能重复');
  return { name, body: input.body, sections, guidance: input.guidance.trim() };
}

/** 组织级模板需要组织管理员；产品级模板需要该产品的管理员。 */
async function requireTemplateAdmin(tx: Tx, actor: Actor, productId: string | null): Promise<void> {
  if (productId) await requireProductRole(tx, actor, productId, 'admin');
  else requireOrgAdmin(actor);
}

/** 产品可用的某类模板：产品自己的启用模板，加上没有被同名产品模板覆盖的启用组织模板。 */
export async function effectiveTemplates(tx: Tx, productId: string, kind: TemplateKind = 'change'): Promise<TemplateView[]> {
  const rows = await tx
    .select()
    .from(documentTemplates)
    .where(and(eq(documentTemplates.kind, kind), eq(documentTemplates.active, true), or(isNull(documentTemplates.productId), eq(documentTemplates.productId, productId))))
    .orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
  const overridden = new Set(rows.filter((r) => r.productId !== null).map((r) => r.name));
  return rows.filter((r) => r.productId !== null || !overridden.has(r.name)).map(view);
}

export async function loadUsableTemplate(tx: Tx, productId: string, templateId: string, kind: TemplateKind = 'change'): Promise<TemplateView> {
  const tpl = (await effectiveTemplates(tx, productId, kind)).find((x) => x.id === templateId);
  if (!tpl) throw new AppError('invalid', '模板不存在或已停用');
  return tpl;
}

/**
 * 按类型（缺省为变更 PRD）列出：不带 productId 为组织级模板（含停用的）；带 productId 为该产品自己的模板（含停用的）；
 * 带 productId 且 usable 为新建文档时可选的模板（effectiveTemplates）。
 */
export async function listTemplates(db: Db, actor: Actor, input: { productId?: string | null; usable?: boolean; kind?: TemplateKind }): Promise<TemplateView[]> {
  const kind = input.kind ?? 'change';
  return withOrg(db, actor.orgId, async (tx) => {
    if (!input.productId) {
      requireNonGuest(actor);
      const rows = await tx.select().from(documentTemplates).where(and(isNull(documentTemplates.productId), eq(documentTemplates.kind, kind))).orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
      return rows.map(view);
    }
    await requireProductRole(tx, actor, input.productId, 'viewer');
    if (input.usable) return effectiveTemplates(tx, input.productId, kind);
    const rows = await tx.select().from(documentTemplates).where(and(eq(documentTemplates.productId, input.productId), eq(documentTemplates.kind, kind))).orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
    return rows.map(view);
  });
}

export async function createTemplate(
  db: Db,
  actor: Actor,
  input: { productId?: string | null; kind?: TemplateKind; name: string; body: string; sections: TemplateSection[]; guidance?: string },
): Promise<TemplateView> {
  const v = validate({ ...input, guidance: input.guidance ?? '' });
  const kind = input.kind ?? 'change';
  return withOrg(db, actor.orgId, async (tx) => {
    const productId = input.productId ?? null;
    await requireTemplateAdmin(tx, actor, productId);
    let row: typeof documentTemplates.$inferSelect;
    try {
      [row] = (await tx.insert(documentTemplates).values({ orgId: actor.orgId, productId, kind, ...v }).returning()) as [typeof documentTemplates.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已有同名模板');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, productId, type: 'template.created', subjectType: 'document_template', subjectId: row.id, actor, payload: { name: row.name, kind } });
    return view(row);
  });
}

export async function updateTemplate(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; body?: string; sections?: TemplateSection[]; guidance?: string; active?: boolean },
): Promise<TemplateView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, id)).for('update');
    if (!cur) throw new AppError('not_found', '模板不存在');
    await requireTemplateAdmin(tx, actor, cur.productId);
    const v = validate({ name: input.name ?? cur.name, body: input.body ?? cur.body, sections: input.sections ?? cur.sections, guidance: input.guidance ?? cur.guidance });
    const next = { ...v, active: input.active ?? cur.active };
    // jsonb 读回时键顺序与写入不同，比较前把小节规整为固定键序
    const canon = (v: unknown): string =>
      JSON.stringify(Array.isArray(v) ? (v as TemplateSection[]).map((x) => ({ heading: x.heading, required: x.required, guidance: x.guidance })) : v);
    const changes = (['name', 'body', 'sections', 'guidance', 'active'] as const)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => canon(c.old) !== canon(c.new));
    if (changes.length === 0) return view(cur);
    let row: typeof documentTemplates.$inferSelect;
    try {
      [row] = (await tx.update(documentTemplates).set({ ...next, updatedAt: new Date() }).where(eq(documentTemplates.id, id)).returning()) as [typeof documentTemplates.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已有同名模板');
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'template.updated',
      subjectType: 'document_template',
      subjectId: id,
      actor,
      payload: { changes: changes.map((c) => (c.field === 'body' ? { field: 'body', old: `${cur.body.length} 字符`, new: `${next.body.length} 字符` } : c)) },
    });
    return view(row);
  });
}

/** 组织缺少预置模板时，由组织管理员在设置页添加（P2-A 之前的组织没有预置 PRD 模板）。 */
export async function createPresetTemplate(db: Db, actor: Actor, kind: TemplateKind = 'change'): Promise<TemplateView> {
  try {
    return await createTemplate(db, actor, kind === 'brief' ? { productId: null, kind, ...BRIEF_TEMPLATE } : { productId: null, kind, ...PRESET_TEMPLATE });
  } catch (e) {
    if (e instanceof AppError && e.code === 'conflict') throw new AppError('conflict', '预置模板已存在');
    throw e;
  }
}
