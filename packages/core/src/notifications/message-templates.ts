import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { productRoleOf, requireNonGuest, requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { messageTemplates, notificationRules, notificationSchedules, productMembers } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { BUILTIN_TEMPLATES, currentBuiltinBody, PREVIOUS_BUILTIN_BODIES } from './builtin';
import { BUILTIN_TEMPLATE_KEYS, type BuiltinTemplateKey, TEMPLATE_FORMATS, type TemplateFormat } from './constants';
import { assertTemplateBody } from './template';

type TemplateRow = typeof messageTemplates.$inferSelect;
export type MessageTemplateView = {
  id: string;
  name: string;
  format: TemplateFormat;
  body: string;
  builtin: boolean;
  builtinKey: BuiltinTemplateKey | null;
  usage: { rules: number; schedules: number };
  createdAt: Date;
  updatedAt: Date;
};

const NOT_FOUND = '模板不存在';

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '模板名称不能为空，且不超过 50 个字');
  return v;
}

function assertFormat(format: string): TemplateFormat {
  if (!(TEMPLATE_FORMATS as readonly string[]).includes(format)) throw new AppError('invalid', '模板格式无效');
  return format as TemplateFormat;
}

function assertBody(format: TemplateFormat, body: string): string {
  if (!body.trim() || body.length > 20_000) throw new AppError('invalid', '模板内容不能为空，且不超过 20000 个字符');
  assertTemplateBody(format, body);
  return body;
}

/**
 * 补齐四个预置模板（已有或同名时跳过）；内容仍是以前默认内容的预置行换成当前默认内容，修改过的不动。
 * 属于基础数据补齐，不记事件。
 */
async function ensureBuiltinsTx(tx: Tx, orgId: string): Promise<void> {
  await tx
    .insert(messageTemplates)
    .values(BUILTIN_TEMPLATE_KEYS.map((k) => ({ orgId, name: BUILTIN_TEMPLATES[k].name, format: BUILTIN_TEMPLATES[k].format, body: BUILTIN_TEMPLATES[k].body, builtin: true, builtinKey: k })))
    .onConflictDoNothing();
  for (const k of BUILTIN_TEMPLATE_KEYS) {
    await tx
      .update(messageTemplates)
      .set({ body: BUILTIN_TEMPLATES[k].body, updatedAt: new Date() })
      .where(and(eq(messageTemplates.builtin, true), eq(messageTemplates.builtinKey, k), inArray(messageTemplates.body, PREVIOUS_BUILTIN_BODIES[k])));
  }
}

async function viewsTx(tx: Tx, rows: TemplateRow[]): Promise<MessageTemplateView[]> {
  const ruleRefs = await tx.select({ id: notificationRules.templateId }).from(notificationRules).where(isNotNull(notificationRules.templateId));
  const scheduleRefs = await tx.select({ id: notificationSchedules.templateId }).from(notificationSchedules).where(isNotNull(notificationSchedules.templateId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    format: r.format,
    body: r.body,
    builtin: r.builtin,
    builtinKey: r.builtinKey,
    usage: { rules: ruleRefs.filter((x) => x.id === r.id).length, schedules: scheduleRefs.filter((x) => x.id === r.id).length },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** 访客只有是某个产品的管理员时才能查看模板（新建、修改事件规则与定时推送时选择模板）。 */
async function requireTemplateReaderTx(tx: Tx, actor: Actor): Promise<void> {
  if (actor.orgRole !== 'guest') return;
  const rows = await tx
    .select({ productId: productMembers.productId })
    .from(productMembers)
    .where(and(eq(productMembers.memberId, actor.memberId), eq(productMembers.role, 'admin')));
  for (const r of rows) if ((await productRoleOf(tx, actor, r.productId)) === 'admin') return;
  requireNonGuest(actor);
}

export async function listMessageTemplates(db: Db, actor: Actor): Promise<MessageTemplateView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireTemplateReaderTx(tx, actor);
    await ensureBuiltinsTx(tx, actor.orgId);
    const rows = await tx.select().from(messageTemplates).orderBy(desc(messageTemplates.builtin), asc(messageTemplates.name));
    return viewsTx(tx, rows);
  });
}

export async function createMessageTemplate(db: Db, actor: Actor, input: { name: string; format: TemplateFormat; body: string }): Promise<MessageTemplateView> {
  requireOrgAdmin(actor);
  const name = assertName(input.name);
  const format = assertFormat(input.format);
  const body = assertBody(format, input.body);
  return withOrg(db, actor.orgId, async (tx) => {
    let row: TemplateRow;
    try {
      [row] = (await tx.insert(messageTemplates).values({ orgId: actor.orgId, name, format, body }).returning()) as [TemplateRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '模板名称已存在');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'message_template.created', subjectType: 'message_template', subjectId: row.id, actor, payload: { name, format } });
    return (await viewsTx(tx, [row]))[0]!;
  });
}

export async function updateMessageTemplate(
  db: Db,
  actor: Actor,
  id: string,
  patch: { name?: string; format?: TemplateFormat; body?: string },
): Promise<MessageTemplateView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, id)).for('no key update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    const name = patch.name === undefined ? cur.name : assertName(patch.name);
    const format = patch.format === undefined ? cur.format : assertFormat(patch.format);
    if (cur.builtin && (name !== cur.name || format !== cur.format)) throw new AppError('invalid', '预置模板只能修改内容');
    const body = assertBody(format, patch.body ?? cur.body);
    const changes = (
      [
        ['name', cur.name, name],
        ['format', cur.format, format],
        ['body', cur.body, body],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([field, old, value]) => ({ field, old, new: value }));
    if (changes.length === 0) return (await viewsTx(tx, [cur]))[0]!;
    let row: TemplateRow;
    try {
      [row] = (await tx.update(messageTemplates).set({ name, format, body, updatedAt: new Date() }).where(eq(messageTemplates.id, id)).returning()) as [TemplateRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '模板名称已存在');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'message_template.updated', subjectType: 'message_template', subjectId: id, actor, payload: { changes } });
    return (await viewsTx(tx, [row]))[0]!;
  });
}

export async function deleteMessageTemplate(db: Db, actor: Actor, id: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    if (cur.builtin) throw new AppError('invalid', '预置模板不能删除');
    const [rule] = await tx.select({ id: notificationRules.id }).from(notificationRules).where(eq(notificationRules.templateId, id)).limit(1);
    const [schedule] = await tx.select({ id: notificationSchedules.id }).from(notificationSchedules).where(eq(notificationSchedules.templateId, id)).limit(1);
    if (rule || schedule) throw new AppError('conflict', '模板正在被规则或定时推送使用');
    await tx.delete(messageTemplates).where(eq(messageTemplates.id, id));
    await recordEvent(tx, { orgId: actor.orgId, type: 'message_template.deleted', subjectType: 'message_template', subjectId: id, actor, payload: { name: cur.name } });
  });
}

/** 渲染用的模板：指定的模板 → 本组织的预置行 → 代码中的默认内容。仍是以前默认内容的预置行按当前默认内容渲染。 */
export async function resolveTemplateTx(tx: Tx, templateId: string | null, key: BuiltinTemplateKey): Promise<{ format: TemplateFormat; body: string }> {
  const cols = { format: messageTemplates.format, body: messageTemplates.body, builtinKey: messageTemplates.builtinKey };
  const [row] = templateId ? await tx.select(cols).from(messageTemplates).where(eq(messageTemplates.id, templateId)) : [];
  const [builtin] = row ? [row] : await tx.select(cols).from(messageTemplates).where(and(eq(messageTemplates.builtin, true), eq(messageTemplates.builtinKey, key)));
  if (!builtin) return { format: BUILTIN_TEMPLATES[key].format, body: BUILTIN_TEMPLATES[key].body };
  return { format: builtin.format, body: builtin.builtinKey ? currentBuiltinBody(builtin.builtinKey, builtin.body) : builtin.body };
}

export async function assertTemplateIdTx(tx: Tx, templateId: string | null | undefined): Promise<string | null> {
  if (!templateId) return null;
  const [row] = await tx.select({ id: messageTemplates.id }).from(messageTemplates).where(eq(messageTemplates.id, templateId));
  if (!row) throw new AppError('invalid', '模板不存在');
  return row.id;
}
