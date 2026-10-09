import { and, asc, eq, inArray } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, functionTags } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor, ProductRole } from '../domain-types';
import { coveredPrdStates, signerIdentity } from '../reviews/snapshot';
import type { CheckTarget } from './check-writes';
import { memberNames } from './context';
import type { CheckState } from './labels';
import type { MemberRef } from './requirements';
import { type CheckItem, checkStatesFor, matchingSignerRules } from './workflow-runtime';

export type CheckItemView = {
  key: string;
  label: string;
  type: 'single' | 'signoff';
  state: CheckState;
  note: string | null;
  meta: Record<string, unknown>;
  updatedAt: Date | null;
  updatedBy: MemberRef | null;
  signers: Array<{ index: number; by: 'function_tag' | 'member' | 'product_role'; ref: string; label: string }>;
  signoffRule: 'all' | 'any' | null;
  signoffs: Array<{ id: string; signer: MemberRef; actedBy: MemberRef | null; ruleIndex: number; decision: 'passed' | 'rejected'; note: string | null; at: Date }>;
  canSign: number[];
  canSignOnBehalf: number[];
  /** 跟随 PRD 状态的检查项。 */
  auto: boolean;
  /** 不能手动修改（需求已被 PRD 覆盖时的 auto 项）。 */
  locked: boolean;
};

const PRODUCT_ROLE_SIGNER_LABEL: Record<string, string> = { admin: '产品管理员', editor: '产品编辑', viewer: '产品只读成员' };

/** 一个对象（需求或 PRD）上若干检查项的视图：状态、备注、签字记录、本人可签与可代签的规则。 */
export async function buildCheckItemViews(
  tx: Tx,
  actor: Actor,
  role: ProductRole,
  items: CheckItem[],
  target: CheckTarget,
  /** 需求被 PRD 覆盖时 auto 项的有效状态（由 PRD 状态推出）；非空时该项显示这个状态并锁定。 */
  opts: { autoState: CheckState | null },
): Promise<CheckItemView[]> {
  if (items.length === 0) return [];
  const results = await tx.select().from(checkItemResults).where(and(eq(checkItemResults.targetType, target.type), eq(checkItemResults.targetId, target.id)));
  const signoffs = results.length
    ? await tx.select().from(checkItemSignoffs).where(inArray(checkItemSignoffs.resultId, results.map((r) => r.id))).orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id))
    : [];
  const signers = items.flatMap((c) => c.signers ?? []);
  const names = await memberNames(tx, [
    ...signoffs.flatMap((s) => [s.signerMemberId, s.actedByMemberId]),
    ...results.map((r) => r.updatedBy),
    ...signers.filter((s) => s.by === 'member').map((s) => s.ref),
  ]);
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  const tagIds = [...new Set(signers.filter((s) => s.by === 'function_tag').map((s) => s.ref))];
  const tagRows = tagIds.length ? await tx.select({ id: functionTags.id, name: functionTags.name }).from(functionTags).where(inArray(functionTags.id, tagIds)) : [];
  const tagName = new Map(tagRows.map((x) => [x.id, x.name]));
  const identity = await signerIdentity(tx, actor, role);
  const canWrite = actor.tokenScope?.access !== 'read';
  return items.map((c) => {
    const result = results.find((r) => r.itemKey === c.key);
    const list = (c.signers ?? []).map((s, index) => ({
      index,
      by: s.by,
      ref: s.ref,
      label: s.by === 'function_tag' ? (tagName.get(s.ref) ?? '已删除的标签') : s.by === 'member' ? (names.get(s.ref) ?? '已删除的成员') : (PRODUCT_ROLE_SIGNER_LABEL[s.ref] ?? s.ref),
    }));
    const autoState = c.auto === 'prd_status' ? opts.autoState : null;
    return {
      key: c.key,
      label: c.label,
      type: c.type,
      state: autoState ?? result?.state ?? c.defaultState,
      note: result?.note ?? null,
      meta: result?.meta ?? {},
      updatedAt: result?.updatedAt ?? null,
      updatedBy: ref(result?.updatedBy ?? null),
      signers: list,
      signoffRule: c.signoffRule ?? null,
      signoffs: signoffs
        .filter((s) => s.resultId === result?.id)
        .map((s) => ({ id: s.id, signer: ref(s.signerMemberId)!, actedBy: ref(s.actedByMemberId), ruleIndex: s.signerRuleIndex, decision: s.decision, note: s.note, at: s.at })),
      canSign: c.type === 'signoff' && canWrite ? matchingSignerRules(c, identity) : [],
      canSignOnBehalf: c.type === 'signoff' && role === 'admin' && canWrite ? list.filter((s) => s.by === 'member' && s.ref !== actor.memberId).map((s) => s.index) : [],
      auto: c.auto === 'prd_status',
      locked: autoState !== null,
    };
  });
}

/** 需求的检查状态：作用于需求的项取需求自己的结果，作用于 PRD 的项取所挂 PRD 的结果（没挂 PRD 时为默认状态）；被覆盖时「PRD」auto 项由 PRD 状态推出。 */
export async function requirementCheckStates(tx: Tx, body: WorkflowBody, req: { id: string; changeDocumentId: string | null }): Promise<Record<string, CheckState>> {
  const docKeys = new Set(body.checkItems.filter((c) => c.scope === 'document').map((c) => c.key));
  const own = await tx
    .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, req.id)));
  const shared = req.changeDocumentId
    ? await tx
        .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, 'document'), eq(checkItemResults.targetId, req.changeDocumentId)))
    : [];
  const covered = await coveredPrdStates(tx, body, [req.id]);
  return { ...checkStatesFor(body, [...own.filter((r) => !docKeys.has(r.itemKey)), ...shared.filter((r) => docKeys.has(r.itemKey))]), ...covered.get(req.id) };
}
