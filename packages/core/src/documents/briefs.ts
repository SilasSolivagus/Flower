import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { documentBriefs, documentRevisions, documents, documentTemplates, functionTags, products, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertAssignableMember, memberNames } from '../requirements/context';
import { assertTitle, type MemberRef } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import type { BriefRow } from './brief-header';
import { type BriefGate, evaluateBriefGate } from './brief-model';
import { BRIEF_GATE_ITEMS, BRIEF_TEMPLATE } from './brief-template';
import type { BriefRelatedLink, DocumentStatus } from './constants';
import { linkBriefRequirementsTx } from './coverage';
import { type DocumentDetail, documentDetailInTx, type DocumentRow, insertNativeDocumentTx } from './documents';
import { briefDisplayKey, fillTemplate, normalizeExternalUrl } from './markdown';
import { effectiveTemplates, loadUsableTemplate } from './templates';

/** 取简报文档与头部（lock 时两行都 FOR UPDATE）；不是简报、已删除或没有头部时按「简报不存在」处理。 */
export async function loadBriefTx(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<{ doc: DocumentRow; header: BriefRow }> {
  const dq = tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.kind, 'brief'), isNull(documents.deletedAt)));
  const [doc] = opts.lock ? await dq.for('update') : await dq;
  if (!doc) throw new AppError('not_found', '简报不存在');
  const hq = tx.select().from(documentBriefs).where(eq(documentBriefs.documentId, id));
  const [header] = opts.lock ? await hq.for('update') : await hq;
  if (!header) throw new AppError('not_found', '简报不存在');
  return { doc, header };
}

/** 简报所在产品的角色：看不到时按「简报不存在」处理，不够时 forbidden。 */
export async function briefRoleTx(tx: Tx, actor: Actor, doc: DocumentRow, need: ProductRole): Promise<ProductRole> {
  const role = await productRoleOf(tx, actor, doc.productId);
  if (!role) throw new AppError('not_found', '简报不存在');
  if (!atLeast(role, need)) throw new AppError('forbidden', '权限不足');
  return role;
}

/**
 * 新建简报：产品编辑及以上。没有指定模板时用产品可用的第一份简报模板（没有时为空白正文）；作者为创建人；状态讨论中。
 */
export async function createBrief(db: Db, actor: Actor, productId: string, input: { title: string; templateId?: string | null; requirementIds?: string[] }): Promise<DocumentDetail> {
  const title = assertTitle(input.title);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'editor');
    const tpl = input.templateId ? await loadUsableTemplate(tx, productId, input.templateId, 'brief') : ((await effectiveTemplates(tx, productId, 'brief'))[0] ?? null);
    const names = await memberNames(tx, [actor.memberId]);
    const markdown = tpl ? fillTemplate(tpl.body, { date: await orgToday(tx, actor.orgId), author: names.get(actor.memberId) ?? '' }) : '';
    const doc = await insertNativeDocumentTx(tx, actor, { productId, kind: 'brief', title, status: 'discussing', ownerMemberId: null, templateId: tpl?.id ?? null, markdown, summary: null });
    await tx.insert(documentBriefs).values({ documentId: doc.id, orgId: actor.orgId, authorMemberId: actor.memberId });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'brief.created',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { number: doc.number, title, templateId: doc.templateId, authorMemberId: actor.memberId },
    });
    if (input.requirementIds?.length) await linkBriefRequirementsTx(tx, actor, doc.id, input.requirementIds);
    return documentDetailInTx(tx, actor, doc.id);
  });
}

export type BriefHeaderInput = {
  version?: string;
  requesterMemberId?: string | null;
  deciderMemberId?: string | null;
  authorMemberId?: string | null;
  participantTagIds?: string[];
  relatedLinks?: BriefRelatedLink[];
};
export type BriefFilter = { productId?: string; statuses?: DocumentStatus[]; deciderId?: string };
export type BriefListItem = {
  id: string;
  productId: string;
  displayKey: string;
  title: string;
  status: DocumentStatus;
  requirementCount: number;
  gate: { passed: number; total: number };
  decider: MemberRef | null;
  updatedAt: Date;
};

/** 比较用的 JSON：对象键按字母序排列。jsonb 读回来的键序与写入时不同，直接 JSON.stringify 会把没变的值当成变化。 */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

const LINKS_MAX = 20;
const TAGS_MAX = 20;
const NOTE_MAX = 100;

function assertVersion(v: string): string {
  const s = v.trim();
  if (!s || s.length > 30) throw new AppError('invalid', '版本不能为空，且不超过 30 个字符');
  return s;
}

function assertLinks(links: BriefRelatedLink[]): BriefRelatedLink[] {
  if (links.length > LINKS_MAX) throw new AppError('invalid', `关联文档不超过 ${LINKS_MAX} 条`);
  return links.map((l): BriefRelatedLink => {
    const note = l.note.trim();
    if (note.length > NOTE_MAX) throw new AppError('invalid', `关联文档的说明不超过 ${NOTE_MAX} 个字符`);
    if (l.kind === 'url') {
      const u = normalizeExternalUrl(l.url);
      if (!u) throw new AppError('invalid', '关联文档的网址无效（需以 http:// 或 https:// 开头，且不含空格）');
      return { kind: 'url', url: u.url, note };
    }
    const target = l.target.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
    if (!target || target.length > 100 || /[[\]|\n]/.test(target)) throw new AppError('invalid', '引用写法无效，例如 PAN-PRD-3');
    return { kind: 'wiki', target, note };
  });
}

/** 一批简报的闸口结果：一次取当前正文、所用模板与勾选人姓名。简报没有模板时按预置简报模板去掉原样内容。 */
export async function briefGatesTx(tx: Tx, rows: Array<{ doc: DocumentRow; header: BriefRow }>): Promise<Map<string, BriefGate>> {
  if (rows.length === 0) return new Map();
  const revIds = rows.map((r) => r.doc.currentRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length > 0 ? await tx.select({ id: documentRevisions.id, snapshot: documentRevisions.snapshot }).from(documentRevisions).where(inArray(documentRevisions.id, revIds)) : [];
  const tplIds = [...new Set(rows.map((r) => r.doc.templateId).filter((x): x is string => !!x))];
  const tpls = tplIds.length > 0 ? await tx.select({ id: documentTemplates.id, body: documentTemplates.body }).from(documentTemplates).where(inArray(documentTemplates.id, tplIds)) : [];
  const names = await memberNames(tx, rows.flatMap((r) => r.header.gateChecks.map((c) => c.memberId)));
  const markdownOf = new Map(revs.map((v) => [v.id, v.snapshot.markdown]));
  const bodyOf = new Map(tpls.map((x) => [x.id, x.body]));
  return new Map(
    rows.map((r) => [
      r.doc.id,
      evaluateBriefGate({
        markdown: r.doc.currentRevisionId ? (markdownOf.get(r.doc.currentRevisionId) ?? '') : '',
        templateBody: (r.doc.templateId ? bodyOf.get(r.doc.templateId) : undefined) ?? BRIEF_TEMPLATE.body,
        checks: r.header.gateChecks,
        names,
      }),
    ]),
  );
}

export async function getBriefGate(db: Db, actor: Actor, id: string): Promise<BriefGate> {
  return withOrg(db, actor.orgId, async (tx) => {
    const b = await loadBriefTx(tx, id);
    await briefRoleTx(tx, actor, b.doc, 'viewer');
    return (await briefGatesTx(tx, [b])).get(id)!;
  });
}

/** 勾选或取消闸口人工项（产品编辑及以上）；状态不变时不写、不记事件。 */
export async function setBriefGateCheck(db: Db, actor: Actor, id: string, item: number, input: { checked: boolean }): Promise<BriefGate> {
  const def = BRIEF_GATE_ITEMS.find((g) => g.no === item);
  if (!def) throw new AppError('invalid', '闸口项不存在');
  if (def.auto) throw new AppError('invalid', '这一项由系统检查，不能手动勾选');
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, header } = await loadBriefTx(tx, id, { lock: true });
    await briefRoleTx(tx, actor, doc, 'editor');
    const cur = header.gateChecks.some((c) => c.item === item);
    let gateChecks = header.gateChecks;
    if (input.checked !== cur) {
      const now = new Date();
      gateChecks = input.checked
        ? [...header.gateChecks, { item, memberId: actor.memberId, at: now.toISOString() }].sort((a, b) => a.item - b.item)
        : header.gateChecks.filter((c) => c.item !== item);
      await tx.update(documentBriefs).set({ gateChecks, updatedAt: now }).where(eq(documentBriefs.documentId, id));
      await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, id));
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: doc.productId,
        type: 'brief.gate_checked',
        subjectType: 'document',
        subjectId: id,
        actor,
        payload: { item, checked: input.checked, changes: [{ field: `gate.${item}`, old: cur, new: input.checked }] },
      });
    }
    return (await briefGatesTx(tx, [{ doc, header: { ...header, gateChecks } }])).get(id)!;
  });
}

/** 改头部信息（产品编辑及以上）。新选的成员须为在职真人成员；参与方须为现有职能标签；只记变化的字段。 */
export async function updateBrief(db: Db, actor: Actor, id: string, input: BriefHeaderInput): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, header: cur } = await loadBriefTx(tx, id, { lock: true });
    await briefRoleTx(tx, actor, doc, 'editor');
    const next = {
      version: input.version === undefined ? cur.version : assertVersion(input.version),
      requesterMemberId: input.requesterMemberId === undefined ? cur.requesterMemberId : input.requesterMemberId,
      deciderMemberId: input.deciderMemberId === undefined ? cur.deciderMemberId : input.deciderMemberId,
      authorMemberId: input.authorMemberId === undefined ? cur.authorMemberId : input.authorMemberId,
      participantTagIds: input.participantTagIds === undefined ? cur.participantTagIds : [...new Set(input.participantTagIds)],
      relatedLinks: input.relatedLinks === undefined ? cur.relatedLinks : assertLinks(input.relatedLinks),
    };
    for (const f of ['requesterMemberId', 'deciderMemberId', 'authorMemberId'] as const) {
      const v = next[f];
      if (v && v !== cur[f]) await assertAssignableMember(tx, v);
    }
    if (input.participantTagIds !== undefined) {
      if (next.participantTagIds.length > TAGS_MAX) throw new AppError('invalid', `参与方不超过 ${TAGS_MAX} 个`);
      const found = next.participantTagIds.length > 0 ? await tx.select({ id: functionTags.id }).from(functionTags).where(inArray(functionTags.id, next.participantTagIds)) : [];
      if (found.length !== next.participantTagIds.length) throw new AppError('invalid', '参与方标签不存在');
    }
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => canonical(c.old) !== canonical(c.new));
    if (changes.length > 0) {
      const now = new Date();
      await tx.update(documentBriefs).set({ ...next, updatedAt: now }).where(eq(documentBriefs.documentId, id));
      await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, id));
      await recordEvent(tx, { orgId: actor.orgId, productId: doc.productId, type: 'brief.updated', subjectType: 'document', subjectId: id, actor, payload: { changes } });
    }
    return documentDetailInTx(tx, actor, id);
  });
}

/** 简报列表：只含看得到的产品；合法 UUID 但看不到或不存在的产品返回空列表。按更新时间倒序。 */
export async function listBriefs(db: Db, actor: Actor, filter: BriefFilter = {}): Promise<BriefListItem[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = [...(await visibleProductIds(tx, actor))];
    const productIds = filter.productId ? visible.filter((p) => p === filter.productId) : visible;
    if (productIds.length === 0) return [];
    const conds: SQL[] = [inArray(documents.productId, productIds), eq(documents.kind, 'brief'), isNull(documents.deletedAt)];
    if (filter.statuses?.length) conds.push(inArray(documents.status, filter.statuses));
    if (filter.deciderId) conds.push(eq(documentBriefs.deciderMemberId, filter.deciderId));
    const rows = await tx
      .select({ doc: documents, header: documentBriefs, key: products.key })
      .from(documents)
      .innerJoin(documentBriefs, eq(documentBriefs.documentId, documents.id))
      .innerJoin(products, eq(products.id, documents.productId))
      .where(and(...conds))
      .orderBy(desc(documents.updatedAt), asc(products.key), desc(documents.number));
    if (rows.length === 0) return [];
    const gates = await briefGatesTx(tx, rows);
    const counts = await tx
      .select({ id: requirements.briefDocumentId, n: sql<number>`count(*)::int` })
      .from(requirements)
      .where(and(inArray(requirements.briefDocumentId, rows.map((r) => r.doc.id)), isNull(requirements.deletedAt)))
      .groupBy(requirements.briefDocumentId);
    const countOf = new Map(counts.map((c) => [c.id!, c.n]));
    const names = await memberNames(tx, rows.map((r) => r.header.deciderMemberId));
    return rows.map(({ doc, header, key }) => {
      const g = gates.get(doc.id)!;
      return {
        id: doc.id,
        productId: doc.productId,
        displayKey: briefDisplayKey(key, doc.number),
        title: doc.title,
        status: doc.status,
        requirementCount: countOf.get(doc.id) ?? 0,
        gate: { passed: g.passed, total: g.total },
        decider: header.deciderMemberId ? { id: header.deciderMemberId, displayName: names.get(header.deciderMemberId) ?? '已删除的成员' } : null,
        updatedAt: doc.updatedAt,
      };
    });
  });
}
