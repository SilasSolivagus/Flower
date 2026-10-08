import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { productRoleOf, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, documentTemplates, products, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { assertAssignableMember, memberNames } from '../requirements/context';
import type { CheckItemView } from '../requirements/detail';
import { assertTitle, productKeyOf, displayKey as requirementDisplayKey, type MemberRef } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import { reanchorDocumentComments } from './comments';
import { linkRequirementsTx, syncPrdCheck } from './coverage';
import type { DocumentStatus, ExternalProvider, RevisionSnapshot } from './constants';
import {
  canTransition,
  diffRevisionSnapshots,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TRANSITIONS,
  documentDisplayKey,
  fillTemplate,
  missingRequiredSections,
  normalizeExternalUrl,
  parseDocumentKey,
  type RevisionDiff,
} from './markdown';
import { loadUsableTemplate } from './templates';

export const MAX_MARKDOWN_CHARS = 300_000;
const MERGE_WINDOW_MS = 5 * 60 * 1000;
const INVALID_URL = '不是有效的网址（需以 http:// 或 https:// 开头，且不含空格）';

export type DocumentListItem = {
  id: string;
  productId: string;
  number: number;
  displayKey: string;
  title: string;
  source: 'native' | 'external';
  status: DocumentStatus;
  owner: MemberRef | null;
  externalUrl: string | null;
  externalProvider: ExternalProvider | null;
  requirementCount: number;
  updatedAt: Date;
};
export type DocumentFilter = { statuses?: DocumentStatus[]; ownerIds?: string[]; source?: 'native' | 'external'; q?: string };
export type DocumentDetail = DocumentListItem & {
  productKey: string;
  version: number;
  templateId: string | null;
  markdown: string | null;
  revisionNumber: number | null;
  myRole: ProductRole;
  transitions: DocumentStatus[];
  requirements: Array<{ id: string; displayKey: string; title: string; stateKey: string }>;
  checkItems: CheckItemView[];
  createdAt: Date;
};
export type RevisionListItem = { number: number; summary: string | null; author: MemberRef | null; createdAt: Date; updatedAt: Date };
export type SaveResult = { version: number; revisionNumber: number; merged: boolean };
type DocRow = typeof documents.$inferSelect;

function assertMarkdown(markdown: string): string {
  if (markdown.length > MAX_MARKDOWN_CHARS) throw new AppError('invalid', `正文不超过 ${MAX_MARKDOWN_CHARS} 个字符`);
  if (/\]\(\s*data:/i.test(markdown)) throw new AppError('invalid', '正文中不能内嵌图片数据，请上传图片');
  return markdown;
}

function assertBaseVersion(doc: DocRow, baseVersion: number): void {
  if (doc.version !== baseVersion) throw new AppError('conflict', '文档已被其他人修改，请重新加载后再编辑', { version: doc.version });
}

export async function loadDocument(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<DocRow> {
  const q = tx.select().from(documents).where(and(eq(documents.id, id), isNull(documents.deletedAt)));
  const [d] = opts.lock ? await q.for('update') : await q;
  if (!d) throw new AppError('not_found', 'PRD 不存在');
  return d;
}

/** 同一产品内一个规范化网址只能对应一份 PRD；except 为正在修改的这份。 */
async function assertUrlFree(tx: Tx, productId: string, key: string, except: string | null): Promise<void> {
  const [other] = await tx
    .select({ id: documents.id, number: documents.number })
    .from(documents)
    .where(and(eq(documents.productId, productId), eq(documents.externalUrlKey, key), isNull(documents.deletedAt)));
  if (other && other.id !== except) throw new AppError('conflict', `该网址已对应 ${documentDisplayKey(await productKeyOf(tx, productId), other.number)}`);
}

async function hydrate(tx: Tx, rows: DocRow[]): Promise<DocumentListItem[]> {
  if (rows.length === 0) return [];
  const keys = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, [...new Set(rows.map((r) => r.productId))]));
  const keyOf = new Map(keys.map((k) => [k.id, k.key]));
  const names = await memberNames(tx, rows.map((r) => r.ownerMemberId));
  const counts = await tx
    .select({ id: requirements.changeDocumentId, n: sql<number>`count(*)::int` })
    .from(requirements)
    .where(and(inArray(requirements.changeDocumentId, rows.map((r) => r.id)), isNull(requirements.deletedAt)))
    .groupBy(requirements.changeDocumentId);
  const countOf = new Map(counts.map((c) => [c.id!, c.n]));
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    number: r.number,
    displayKey: documentDisplayKey(keyOf.get(r.productId)!, r.number),
    title: r.title,
    source: r.source,
    status: r.status,
    owner: r.ownerMemberId ? { id: r.ownerMemberId, displayName: names.get(r.ownerMemberId) ?? '已删除的成员' } : null,
    externalUrl: r.externalUrl,
    externalProvider: r.externalProvider,
    requirementCount: countOf.get(r.id) ?? 0,
    updatedAt: r.updatedAt,
  }));
}

async function detailOf(tx: Tx, actor: Actor, doc: DocRow): Promise<DocumentDetail> {
  const role = await productRoleOf(tx, actor, doc.productId);
  if (!role) throw new AppError('not_found', 'PRD 不存在');
  const [base] = await hydrate(tx, [doc]);
  const productKey = await productKeyOf(tx, doc.productId);
  const [rev] = doc.currentRevisionId ? await tx.select().from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId)) : [];
  const reqs = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.changeDocumentId, doc.id), isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.number));
  return {
    ...base!,
    productKey,
    version: doc.version,
    templateId: doc.templateId,
    markdown: rev ? rev.snapshot.markdown : null,
    revisionNumber: rev ? rev.version : null,
    myRole: role,
    transitions: role === 'viewer' ? [] : DOCUMENT_TRANSITIONS[doc.status],
    requirements: reqs.map((r) => ({ id: r.id, displayKey: requirementDisplayKey(productKey, r.number), title: r.title, stateKey: r.stateKey })),
    checkItems: [],
    createdAt: doc.createdAt,
  };
}

export async function documentDetailInTx(tx: Tx, actor: Actor, id: string): Promise<DocumentDetail> {
  return detailOf(tx, actor, await loadDocument(tx, id));
}

/**
 * 写一条修订：同一作者、距该作者上次保存不到 5 分钟、且上一条没有摘要（不是恢复或转换产生的）时覆盖上一条，
 * 否则新建。调用方已锁住文档行。
 */
async function writeRevision(
  tx: Tx,
  actor: Actor,
  doc: DocRow,
  snapshot: RevisionSnapshot,
  opts: { summary: string | null; allowMerge: boolean },
): Promise<{ id: string; number: number; merged: boolean }> {
  const [latest] = await tx.select().from(documentRevisions).where(eq(documentRevisions.documentId, doc.id)).orderBy(desc(documentRevisions.version)).limit(1);
  const now = new Date();
  if (
    opts.allowMerge &&
    latest &&
    latest.summary === null &&
    latest.authorMemberId === actor.memberId &&
    now.getTime() - latest.updatedAt.getTime() < MERGE_WINDOW_MS
  ) {
    await tx.update(documentRevisions).set({ snapshot, updatedAt: now }).where(eq(documentRevisions.id, latest.id));
    return { id: latest.id, number: latest.version, merged: true };
  }
  const [rev] = await tx
    .insert(documentRevisions)
    .values({ orgId: actor.orgId, documentId: doc.id, version: (latest?.version ?? 0) + 1, snapshot, summary: opts.summary, authorMemberId: actor.memberId, createdAt: now, updatedAt: now })
    .returning();
  return { id: rev!.id, number: rev!.version, merged: false };
}

export async function createDocument(
  db: Db,
  actor: Actor,
  productId: string,
  input: { title: string; ownerMemberId?: string | null; templateId?: string | null; externalUrl?: string | null; requirementIds?: string[] },
): Promise<DocumentDetail> {
  const title = assertTitle(input.title);
  const wantsExternal = !!input.externalUrl?.trim();
  const external = wantsExternal ? normalizeExternalUrl(input.externalUrl!) : null;
  if (wantsExternal && !external) throw new AppError('invalid', INVALID_URL);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'editor');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    if (external) await assertUrlFree(tx, productId, external.key, null);
    let markdown = '';
    let templateId: string | null = null;
    if (!external && input.templateId) {
      const tpl = await loadUsableTemplate(tx, productId, input.templateId);
      templateId = tpl.id;
      const names = await memberNames(tx, [actor.memberId]);
      markdown = fillTemplate(tpl.body, { date: await orgToday(tx, actor.orgId), author: names.get(actor.memberId) ?? '' });
    }
    const [seq] = await tx
      .update(products)
      .set({ documentSeq: sql`${products.documentSeq} + 1` })
      .where(eq(products.id, productId))
      .returning({ n: products.documentSeq });
    let doc: DocRow;
    try {
      [doc] = (await tx
        .insert(documents)
        .values({
          orgId: actor.orgId,
          productId,
          number: seq!.n,
          kind: 'change',
          source: external ? 'external' : 'native',
          title,
          ownerMemberId: input.ownerMemberId ?? null,
          templateId,
          status: 'draft',
          externalUrl: external?.url ?? null,
          externalUrlKey: external?.key ?? null,
          externalProvider: external?.provider ?? null,
          createdBy: actor.memberId,
        })
        .returning()) as [DocRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '该网址已对应其他 PRD');
      throw e;
    }
    if (!external) {
      const rev = await writeRevision(tx, actor, doc, { title, markdown }, { summary: null, allowMerge: false });
      await tx.update(documents).set({ currentRevisionId: rev.id }).where(eq(documents.id, doc.id));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'document.created',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { number: doc.number, title, source: doc.source, externalUrl: doc.externalUrl, templateId },
    });
    if (input.requirementIds?.length) await linkRequirementsTx(tx, actor, doc.id, input.requirementIds);
    return documentDetailInTx(tx, actor, doc.id);
  });
}

export async function listDocuments(db: Db, actor: Actor, productId: string, filter: DocumentFilter = {}): Promise<DocumentListItem[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const conds: SQL[] = [eq(documents.productId, productId), eq(documents.kind, 'change'), isNull(documents.deletedAt)];
    if (filter.statuses?.length) conds.push(inArray(documents.status, filter.statuses));
    if (filter.ownerIds?.length) conds.push(inArray(documents.ownerMemberId, filter.ownerIds));
    if (filter.source) conds.push(eq(documents.source, filter.source));
    const q = filter.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const num = /^(?:[A-Za-z][A-Za-z0-9]*-PRD-)?(\d{1,9})$/i.exec(q);
      const parts = [ilike(documents.title, like), ilike(documents.externalUrl, like)];
      if (num) parts.push(eq(documents.number, Number(num[1])));
      conds.push(or(...parts)!);
    }
    const rows = await tx.select().from(documents).where(and(...conds)).orderBy(desc(documents.updatedAt), desc(documents.number));
    return hydrate(tx, rows);
  });
}

export async function getDocument(db: Db, actor: Actor, id: string): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, (tx) => documentDetailInTx(tx, actor, id));
}

export async function getDocumentByKey(db: Db, actor: Actor, key: string): Promise<DocumentDetail> {
  const parsed = parseDocumentKey(key);
  if (!parsed) throw new AppError('not_found', 'PRD 不存在');
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ d: documents })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(and(eq(products.key, parsed.productKey), eq(documents.number, parsed.number), isNull(documents.deletedAt), isNull(products.deletedAt)));
    if (!row) throw new AppError('not_found', 'PRD 不存在');
    return detailOf(tx, actor, row.d);
  });
}

export async function updateDocument(
  db: Db,
  actor: Actor,
  id: string,
  input: { title?: string; ownerMemberId?: string | null; externalUrl?: string },
): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const next = {
      title: input.title === undefined ? cur.title : assertTitle(input.title),
      ownerMemberId: input.ownerMemberId === undefined ? cur.ownerMemberId : input.ownerMemberId,
      externalUrl: cur.externalUrl,
      externalUrlKey: cur.externalUrlKey,
      externalProvider: cur.externalProvider,
    };
    if (next.ownerMemberId && next.ownerMemberId !== cur.ownerMemberId) await assertAssignableMember(tx, next.ownerMemberId);
    if (input.externalUrl !== undefined) {
      if (cur.source !== 'external') throw new AppError('invalid', '只有外部 PRD 可以修改链接');
      const ext = normalizeExternalUrl(input.externalUrl);
      if (!ext) throw new AppError('invalid', INVALID_URL);
      if (ext.key !== cur.externalUrlKey) await assertUrlFree(tx, cur.productId, ext.key, cur.id);
      Object.assign(next, { externalUrl: ext.url, externalUrlKey: ext.key, externalProvider: ext.provider });
    }
    const changes = (['title', 'ownerMemberId', 'externalUrl'] as const).map((field) => ({ field, old: cur[field], new: next[field] })).filter((c) => c.old !== c.new);
    if (changes.length > 0) {
      const extra: { version?: number; currentRevisionId?: string } = {};
      if (next.title !== cur.title && cur.source === 'native') {
        const [curRev] = cur.currentRevisionId ? await tx.select().from(documentRevisions).where(eq(documentRevisions.id, cur.currentRevisionId)) : [];
        const rev = await writeRevision(tx, actor, cur, { title: next.title, markdown: curRev?.snapshot.markdown ?? '' }, { summary: null, allowMerge: true });
        extra.version = cur.version + 1;
        extra.currentRevisionId = rev.id;
      }
      try {
        await tx.update(documents).set({ ...next, ...extra, updatedAt: new Date() }).where(eq(documents.id, id));
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError('conflict', '该网址已对应其他 PRD');
        throw e;
      }
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'document.updated', subjectType: 'document', subjectId: id, actor, payload: { changes } });
    }
    return documentDetailInTx(tx, actor, id);
  });
}

export async function saveDocumentContent(db: Db, actor: Actor, id: string, input: { baseVersion: number; markdown: string; title?: string }): Promise<SaveResult> {
  const markdown = assertMarkdown(input.markdown);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (doc.source !== 'native') throw new AppError('invalid', '外部 PRD 没有正文，请先转为 Flower 文档');
    assertBaseVersion(doc, input.baseVersion);
    const title = input.title === undefined ? doc.title : assertTitle(input.title);
    const rev = await writeRevision(tx, actor, doc, { title, markdown }, { summary: null, allowMerge: true });
    const version = doc.version + 1;
    await tx.update(documents).set({ title, version, currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(documents.id, id));
    await reanchorDocumentComments(tx, id, markdown);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.saved',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { revision: rev.number, merged: rev.merged, changes: title === doc.title ? [] : [{ field: 'title', old: doc.title, new: title }] },
    });
    return { version, revisionNumber: rev.number, merged: rev.merged };
  });
}

export async function listRevisions(db: Db, actor: Actor, id: string): Promise<RevisionListItem[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const rows = await tx.select().from(documentRevisions).where(eq(documentRevisions.documentId, id)).orderBy(desc(documentRevisions.version));
    const names = await memberNames(tx, rows.map((r) => r.authorMemberId));
    return rows.map((r) => ({
      number: r.version,
      summary: r.summary,
      author: r.authorMemberId ? { id: r.authorMemberId, displayName: names.get(r.authorMemberId) ?? '已删除的成员' } : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  });
}

async function revisionSnapshot(tx: Tx, documentId: string, number: number): Promise<typeof documentRevisions.$inferSelect> {
  const [rev] = await tx.select().from(documentRevisions).where(and(eq(documentRevisions.documentId, documentId), eq(documentRevisions.version, number)));
  if (!rev) throw new AppError('not_found', `第 ${number} 版不存在`);
  return rev;
}

export async function getRevision(db: Db, actor: Actor, id: string, number: number): Promise<{ number: number; title: string; markdown: string; createdAt: Date }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const rev = await revisionSnapshot(tx, id, number);
    return { number: rev.version, title: rev.snapshot.title, markdown: rev.snapshot.markdown, createdAt: rev.createdAt };
  });
}

export async function diffRevisions(db: Db, actor: Actor, id: string, input: { from: number; to: number }): Promise<RevisionDiff> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const [a, b] = [await revisionSnapshot(tx, id, input.from), await revisionSnapshot(tx, id, input.to)];
    return diffRevisionSnapshots(a.snapshot, b.snapshot);
  });
}

export async function restoreRevision(db: Db, actor: Actor, id: string, input: { number: number; baseVersion: number }): Promise<SaveResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (doc.source !== 'native') throw new AppError('invalid', '外部 PRD 没有修订');
    assertBaseVersion(doc, input.baseVersion);
    const target = await revisionSnapshot(tx, id, input.number);
    const rev = await writeRevision(tx, actor, doc, target.snapshot, { summary: `恢复到第 ${input.number} 版`, allowMerge: false });
    const version = doc.version + 1;
    await tx.update(documents).set({ title: target.snapshot.title, version, currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(documents.id, id));
    await reanchorDocumentComments(tx, id, target.snapshot.markdown);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.restored',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { from: input.number, revision: rev.number, changes: target.snapshot.title === doc.title ? [] : [{ field: 'title', old: doc.title, new: target.snapshot.title }] },
    });
    return { version, revisionNumber: rev.number, merged: false };
  });
}

export async function transitionDocument(db: Db, actor: Actor, id: string, input: { to: DocumentStatus }): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (!canTransition(doc.status, input.to)) {
      throw new AppError('invalid', `不能从「${DOCUMENT_STATUS_LABELS[doc.status]}」改为「${DOCUMENT_STATUS_LABELS[input.to]}」`);
    }
    if (input.to === 'review' && doc.source === 'native' && doc.templateId) {
      const [tpl] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, doc.templateId));
      const [rev] = doc.currentRevisionId ? await tx.select().from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId)) : [];
      const missing = tpl ? missingRequiredSections(rev?.snapshot.markdown ?? '', tpl) : [];
      if (missing.length > 0) throw new AppError('invalid', `以下必填小节未填写：${missing.join('、')}`, { missing });
    }
    await tx.update(documents).set({ status: input.to, updatedAt: new Date() }).where(eq(documents.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.status_changed',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: doc.status, new: input.to }] },
    });
    const covered = await tx
      .select({ id: requirements.id })
      .from(requirements)
      .where(and(eq(requirements.changeDocumentId, id), isNull(requirements.deletedAt)))
      .orderBy(asc(requirements.id))
      .for('update');
    await syncPrdCheck(tx, actor, { id, productId: doc.productId, status: input.to }, covered.map((r) => r.id));
    return documentDetailInTx(tx, actor, id);
  });
}

export async function convertExternalDocument(db: Db, actor: Actor, id: string, input: { baseVersion: number; markdown: string }): Promise<SaveResult> {
  const markdown = assertMarkdown(input.markdown);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (doc.source !== 'external') throw new AppError('invalid', '只有外部 PRD 可以转为 Flower 文档');
    assertBaseVersion(doc, input.baseVersion);
    const rev = await writeRevision(tx, actor, doc, { title: doc.title, markdown }, { summary: '由外部文档转换', allowMerge: false });
    const version = doc.version + 1;
    await tx.update(documents).set({ source: 'native', currentRevisionId: rev.id, version, updatedAt: new Date() }).where(eq(documents.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.converted',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { revision: rev.number, externalUrl: doc.externalUrl, changes: [{ field: 'source', old: 'external', new: 'native' }] },
    });
    return { version, revisionNumber: rev.number, merged: false };
  });
}
