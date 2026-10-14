/** 组织的跟进阈值（P3-C1）：存在 organizations.settings.tracking，缺省或无效项取默认值。 */
import { eq } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { organizations } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { type TrackingSettings, trackingSettingsOf } from './aging';

const KEYS = ['warnDays', 'alertDays', 'staleUpdateDays'] as const;

export async function getTrackingSettings(db: Db, actor: Actor): Promise<TrackingSettings> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId));
    return trackingSettingsOf(org?.settings ?? {});
  });
}

/** 组织管理员修改：每项为 1–365 的整数，且标黄天数小于标红天数。没有变化时不写。 */
export async function updateTrackingSettings(db: Db, actor: Actor, input: TrackingSettings): Promise<TrackingSettings> {
  requireOrgAdmin(actor);
  for (const k of KEYS) {
    const v = input[k];
    if (!Number.isInteger(v) || v < 1 || v > 365) throw new AppError('invalid', '天数应为 1–365 的整数');
  }
  if (input.warnDays >= input.alertDays) throw new AppError('invalid', '标黄天数应小于标红天数');
  const next: TrackingSettings = { warnDays: input.warnDays, alertDays: input.alertDays, staleUpdateDays: input.staleUpdateDays };
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId)).for('update');
    if (!cur) throw new AppError('not_found', '组织不存在');
    const old = trackingSettingsOf(cur.settings);
    const changes = KEYS.map((field) => ({ field, old: old[field], new: next[field] })).filter((c) => c.old !== c.new);
    if (changes.length === 0) return next;
    await tx.update(organizations).set({ settings: { ...cur.settings, tracking: next } }).where(eq(organizations.id, actor.orgId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'organization.tracking_settings_changed',
      subjectType: 'organization',
      subjectId: actor.orgId,
      actor,
      payload: { changes },
    });
    return next;
  });
}
