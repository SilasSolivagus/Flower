import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { memberNotificationPrefs, members, notificationChannels, organizations, products, wecomApps } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, OrgRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { DEFAULT_NOTIFICATION_PREFS, MEMBER_NOTIFICATION_KINDS, type MemberNotificationKind, type NotificationPref } from '../notifications/constants';

export type NotificationPrefRow = { kind: MemberNotificationKind } & NotificationPref;
export type NotificationSettings = {
  prefs: NotificationPrefRow[];
  wecom: { userid: string | null; bindEnabled: boolean; productChannels: number };
  email: { address: string | null; channelConfigured: boolean };
};
type PrefMap = Record<MemberNotificationKind, NotificationPref>;

const P = memberNotificationPrefs;
const isAdminRole = (role: OrgRole): boolean => role === 'owner' || role === 'admin';

/** 成员可以设置、会收到的通知类型：系统告警只给组织管理员。 */
export function kindsForRole(orgRole: OrgRole): MemberNotificationKind[] {
  return MEMBER_NOTIFICATION_KINDS.filter((k) => k !== 'system_alert' || isAdminRole(orgRole));
}

function withDefaults(rows: Array<{ kind: MemberNotificationKind } & NotificationPref>): PrefMap {
  const out = Object.fromEntries(MEMBER_NOTIFICATION_KINDS.map((k) => [k, { ...DEFAULT_NOTIFICATION_PREFS[k] }])) as PrefMap;
  for (const r of rows) out[r.kind] = { inApp: r.inApp, wecom: r.wecom, email: r.email };
  return out;
}

/** 一批成员的偏好（没有记录的取默认）。 */
export async function prefsForTx(tx: Tx, memberIds: string[]): Promise<Map<string, PrefMap>> {
  const unique = [...new Set(memberIds)];
  const rows = unique.length
    ? await tx.select({ memberId: P.memberId, kind: P.kind, inApp: P.inApp, wecom: P.wecom, email: P.email }).from(P).where(inArray(P.memberId, unique))
    : [];
  return new Map(unique.map((id) => [id, withDefaults(rows.filter((r) => r.memberId === id))]));
}

async function settingsTx(tx: Tx, actor: Actor): Promise<NotificationSettings> {
  const [me] = await tx.select({ email: members.email, orgRole: members.orgRole, wecomUserid: members.wecomUserid }).from(members).where(eq(members.id, actor.memberId));
  if (!me) throw new AppError('not_found', '成员不存在');
  const prefs = (await prefsForTx(tx, [actor.memberId])).get(actor.memberId)!;
  const [app] = await tx.select({ bindEnabled: wecomApps.bindEnabled }).from(wecomApps).where(eq(wecomApps.orgId, actor.orgId));
  const visible = [...(await visibleProductIds(tx, actor))];
  const withChannel = visible.length
    ? await tx
        .select({ id: products.id })
        .from(products)
        .where(and(inArray(products.id, visible), isNotNull(products.personalChannelId), isNull(products.deletedAt)))
    : [];
  const [org] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, actor.orgId));
  const [mail] = org?.channelId
    ? await tx
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(and(eq(notificationChannels.id, org.channelId), eq(notificationChannels.enabled, true), eq(notificationChannels.kind, 'email')))
    : [];
  return {
    prefs: kindsForRole(me.orgRole).map((kind) => ({ kind, ...prefs[kind] })),
    wecom: { userid: me.wecomUserid, bindEnabled: app?.bindEnabled ?? false, productChannels: withChannel.length },
    email: { address: me.email, channelConfigured: !!mail },
  };
}

export async function getNotificationSettings(db: Db, actor: Actor): Promise<NotificationSettings> {
  return withOrg(db, actor.orgId, (tx) => settingsTx(tx, actor));
}

export async function setNotificationPref(db: Db, actor: Actor, kind: MemberNotificationKind, pref: NotificationPref): Promise<NotificationSettings> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能修改通知偏好');
  return withOrg(db, actor.orgId, async (tx) => {
    const [me] = await tx.select({ orgRole: members.orgRole }).from(members).where(eq(members.id, actor.memberId));
    if (!me) throw new AppError('not_found', '成员不存在');
    if (!kindsForRole(me.orgRole).includes(kind)) throw new AppError('invalid', '只有组织管理员接收系统告警');
    const cur = (await prefsForTx(tx, [actor.memberId])).get(actor.memberId)![kind];
    const next: NotificationPref = { inApp: pref.inApp, wecom: pref.wecom, email: pref.email };
    await tx
      .insert(P)
      .values({ orgId: actor.orgId, memberId: actor.memberId, kind, ...next })
      .onConflictDoUpdate({ target: [P.memberId, P.kind], set: { ...next, updatedAt: new Date() } });
    const changes = (['inApp', 'wecom', 'email'] as const).map((field) => ({ field, old: cur[field], new: next[field] })).filter((c) => c.old !== c.new);
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.notification_pref_set', subjectType: 'member', subjectId: actor.memberId, actor, payload: { kind, changes } });
    return settingsTx(tx, actor);
  });
}
