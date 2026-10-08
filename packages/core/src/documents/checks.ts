import { and, desc, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documents, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { buildCheckItemViews, type CheckItemView } from '../requirements/check-views';
import { assertCheckState, type SignInput, writeSignoff, writeSingleCheck } from '../requirements/check-writes';
import { memberNames, productWorkflowBody } from '../requirements/context';
import type { CheckState } from '../requirements/labels';
import type { MemberRef } from '../requirements/requirements';
import { signoffProgress } from '../requirements/workflow-runtime';
import type { ReviewCell, ReviewWaiting } from '../reviews/queue';
import { documentSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';
import type { DocumentStatus } from './constants';
import { loadDocument } from './documents';
import { documentDisplayKey } from './markdown';

export type DocumentReviewRow = {
  id: string;
  displayKey: string;
  title: string;
  source: 'native' | 'external';
  status: DocumentStatus;
  owner: MemberRef | null;
  cells: Record<string, ReviewCell>;
  waiting: ReviewWaiting[];
};
export type DocumentReviewQueue = { columns: Array<{ key: string; label: string; type: 'single' | 'signoff' }>; rows: DocumentReviewRow[] };

export async function documentCheckItemViews(tx: Tx, actor: Actor, role: ProductRole, doc: { id: string; productId: string }): Promise<CheckItemView[]> {
  const body = await productWorkflowBody(tx, doc.productId);
  return buildCheckItemViews(tx, actor, role, body.checkItems.filter((c) => c.scope === 'document'), { type: 'document', id: doc.id }, { lockedAuto: false });
}

async function documentItem(tx: Tx, productId: string, itemKey: string) {
  const body = await productWorkflowBody(tx, productId);
  const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'document');
  if (!item) throw new AppError('not_found', '检查项不存在');
  return item;
}

export async function setDocumentCheckItemState(
  db: Db,
  actor: Actor,
  documentId: string,
  itemKey: string,
  input: { state: CheckState; note?: string | null },
): Promise<{ state: CheckState }> {
  assertCheckState(input.state);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    const item = await documentItem(tx, doc.productId, itemKey);
    const changes = await writeSingleCheck(tx, actor, { type: 'document', id: doc.id }, item, input);
    await tx.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, doc.id));
    await recordEvent(tx, { orgId: actor.orgId, productId: doc.productId, type: 'check_item.updated', subjectType: 'document', subjectId: doc.id, actor, payload: { itemKey, changes } });
    return { state: input.state };
  });
}

export async function signDocumentCheckItem(db: Db, actor: Actor, documentId: string, itemKey: string, input: SignInput): Promise<{ state: CheckState }> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能签字');
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    const item = await documentItem(tx, doc.productId, itemKey);
    const r = await writeSignoff(tx, actor, role, { type: 'document', id: doc.id }, item, input);
    await tx.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, doc.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'check_item.signed',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { itemKey, ruleIndex: r.ruleIndex, decision: input.decision, onBehalf: !!input.onBehalf, changes: r.old === r.state ? [] : [{ field: 'state', old: r.old, new: r.state }] },
    });
    return { state: r.state };
  });
}

/** PRD 评审表：产品内处于评审中的 PRD，每个作用于 PRD 的检查项一列。 */
export async function listDocumentReviewQueue(db: Db, actor: Actor, productId: string): Promise<DocumentReviewQueue> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'viewer');
    const body = await productWorkflowBody(tx, productId);
    const items = body.checkItems.filter((c) => c.scope === 'document');
    const columns = items.map((c) => ({ key: c.key, label: c.label, type: c.type }));
    if (items.length === 0) return { columns, rows: [] };
    const docRows = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.productId, productId), eq(documents.status, 'review'), isNull(documents.deletedAt)))
      .orderBy(desc(documents.number));
    const snaps = await documentSnapshots(tx, body, docRows.map((d) => d.id));
    const who = await signerIdentity(tx, actor, role);
    const canSign = actor.tokenScope?.access !== 'read';
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.id, productId));
    const names = await memberNames(tx, docRows.map((d) => d.ownerMemberId));
    const rows = docRows.map((d) => {
      const snap = snaps.get(d.id)!;
      const cells: Record<string, ReviewCell> = {};
      for (const c of items) {
        const progress = c.type === 'signoff' ? signoffProgress(c, snap.signoffs.get(c.key) ?? []) : null;
        cells[c.key] = { state: snap.states[c.key]!, passed: progress?.passed ?? null, total: progress?.total ?? null };
      }
      return {
        id: d.id,
        displayKey: documentDisplayKey(product!.key, d.number),
        title: d.title,
        source: d.source,
        status: d.status,
        owner: d.ownerMemberId ? { id: d.ownerMemberId, displayName: names.get(d.ownerMemberId) ?? '已删除的成员' } : null,
        cells,
        waiting: canSign ? waitingFor(items, snap, who, role === 'admin', true) : [],
      };
    });
    return { columns, rows };
  });
}
