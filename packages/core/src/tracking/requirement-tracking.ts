/**
 * 需求的跟进设置（P3-C1）：自动加入、手动加入与移出、预计上线日期、暂停与恢复。
 * 写操作要求产品编辑及以上，同一事务内记领域事件。暂停与恢复各记一条事件，用来计算扣除暂停的停留天数。
 */
import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { loadRequirementForUpdate, productWorkflowBody } from '../requirements/context';
import { CLOSED_CATEGORIES, TRACKED_CATEGORIES } from './aging';

type ReqRow = typeof requirements.$inferSelect;

export type RequirementTracking = {
  /** 加入跟进的时间；从未加入或已移出时为 null。上线或取消后保留。 */
  trackedSince: Date | null;
  /** 跟进中：已加入，且当前状态不在已完成、已取消类别。 */
  active: boolean;
  /** 手动移出过：之后状态变化不再自动加入。 */
  optedOut: boolean;
  expectedDate: string | null;
  paused: { at: Date; reason: string } | null;
};

export function trackingView(row: Pick<ReqRow, 'trackedSince' | 'trackingOptedOut' | 'expectedDate' | 'pausedAt' | 'pauseReason'>, category: string): RequirementTracking {
  return {
    trackedSince: row.trackedSince,
    active: row.trackedSince !== null && !CLOSED_CATEGORIES.includes(category),
    optedOut: row.trackingOptedOut,
    expectedDate: row.expectedDate,
    paused: row.pausedAt ? { at: row.pausedAt, reason: row.pauseReason ?? '' } : null,
  };
}

/** 暂停原因：去掉首尾空白后 1–200 字。需求与工作项共用。 */
export function assertPauseReason(reason: string): string {
  const r = reason.trim();
  if (!r || r.length > 200) throw new AppError('invalid', '暂停原因不能为空，且不超过 200 个字符');
  return r;
}

/** 需求当前状态的类别；状态不在流程里时按 backlog。 */
async function categoryOf(tx: Tx, row: Pick<ReqRow, 'productId' | 'stateKey'>): Promise<string> {
  const body = await productWorkflowBody(tx, row.productId);
  return body.states.find((s) => s.key === row.stateKey)?.category ?? 'backlog';
}

/**
 * 状态进入未开始或进行中类别时自动加入跟进。在调用方的事务里、状态写入之后调用（状态流转、新建需求）。
 * 已加入或曾手动移出的不变。加入时记 requirement.tracking_joined（auto: true）。返回是否加入。
 */
export async function autoTrackTx(
  tx: Tx,
  actor: Actor,
  row: Pick<ReqRow, 'id' | 'productId' | 'trackedSince' | 'trackingOptedOut'>,
  category: string,
  at: Date,
): Promise<boolean> {
  if (!TRACKED_CATEGORIES.includes(category) || row.trackedSince || row.trackingOptedOut) return false;
  await tx.update(requirements).set({ trackedSince: at }).where(eq(requirements.id, row.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: row.productId,
    type: 'requirement.tracking_joined',
    subjectType: 'requirement',
    subjectId: row.id,
    actor,
    payload: { auto: true, changes: [{ field: 'trackedSince', old: null, new: at.toISOString() }] },
  });
  return true;
}

/** 改预计上线日期并记事件（调用方已加锁读取需求并校验权限）；与原值相同时不写。写进展时顺手改日期也用它。 */
export async function setExpectedDateTx(tx: Tx, actor: Actor, cur: Pick<ReqRow, 'id' | 'productId' | 'expectedDate'>, next: string | null): Promise<void> {
  if (cur.expectedDate === next) return;
  await tx.update(requirements).set({ expectedDate: next, updatedAt: new Date() }).where(eq(requirements.id, cur.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: cur.productId,
    type: 'requirement.expected_date_changed',
    subjectType: 'requirement',
    subjectId: cur.id,
    actor,
    payload: { changes: [{ field: 'expectedDate', old: cur.expectedDate, new: next }] },
  });
}

/** 写操作的公共部分：加锁读取需求，要求产品编辑及以上，返回当前行与状态类别。 */
async function lockForTracking(tx: Tx, actor: Actor, requirementId: string): Promise<{ cur: ReqRow; category: string }> {
  const cur = await loadRequirementForUpdate(tx, requirementId);
  await requireProductRole(tx, actor, cur.productId, 'editor');
  return { cur, category: await categoryOf(tx, cur) };
}

export async function joinTracking(db: Db, actor: Actor, requirementId: string): Promise<RequirementTracking> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (CLOSED_CATEGORIES.includes(category)) throw new AppError('invalid', '已上线或已取消的需求不能加入跟进');
    if (cur.trackedSince) throw new AppError('invalid', '需求已在跟进中');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ trackedSince: now, trackingOptedOut: false, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.tracking_joined',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { auto: false, changes: [{ field: 'trackedSince', old: null, new: now.toISOString() }] },
    });
    return trackingView(row!, category);
  });
}

/** 移出跟进：只有跟进中的需求可以移出；清空加入时间并记下移出标记。暂停标记不动（暂停与恢复事件始终成对）。 */
export async function leaveTracking(db: Db, actor: Actor, requirementId: string): Promise<RequirementTracking> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (!trackingView(cur, category).active) throw new AppError('invalid', '需求不在跟进中');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ trackedSince: null, trackingOptedOut: true, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.tracking_left',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { changes: [{ field: 'trackedSince', old: cur.trackedSince!.toISOString(), new: null }] },
    });
    return trackingView(row!, category);
  });
}

export async function setRequirementExpectedDate(db: Db, actor: Actor, requirementId: string, expectedDate: string | null): Promise<RequirementTracking> {
  const next = expectedDate === null ? null : assertIsoDate(expectedDate, '预计上线日期');
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    await setExpectedDateTx(tx, actor, cur, next);
    return trackingView({ ...cur, expectedDate: next }, category);
  });
}

/** 暂停：只有跟进中的需求可以暂停；状态不变。已在暂停时报错，不写重复的暂停事件。 */
export async function pauseRequirement(db: Db, actor: Actor, requirementId: string, input: { reason: string }): Promise<RequirementTracking> {
  const reason = assertPauseReason(input.reason);
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (!trackingView(cur, category).active) throw new AppError('invalid', '只有跟进中的需求可以暂停');
    if (cur.pausedAt) throw new AppError('invalid', '需求已暂停');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ pausedAt: now, pauseReason: reason, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.paused',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { reason, changes: [{ field: 'paused', old: false, new: true }] },
    });
    return trackingView(row!, category);
  });
}

/** 恢复：只要求正在暂停（移出跟进或改状态后也可以恢复）。 */
export async function resumeRequirement(db: Db, actor: Actor, requirementId: string): Promise<RequirementTracking> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (!cur.pausedAt) throw new AppError('invalid', '需求没有暂停');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ pausedAt: null, pauseReason: null, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.resumed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { pausedAt: cur.pausedAt.toISOString(), changes: [{ field: 'paused', old: true, new: false }] },
    });
    return trackingView(row!, category);
  });
}
