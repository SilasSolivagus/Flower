import { and, eq, inArray } from 'drizzle-orm';
import { memberNotifications, members, organizations } from '../db/schema';
import type { Tx } from '../db/tx';
import type { ScheduleRow } from '../notifications/schedules';
import { dispatchPersonalTx, type OutboundItem } from './dispatch';
import { prefsForTx } from './prefs';

/**
 * 定时推送由正常变为告警时，在写告警的同一事务里给在职的组织管理员写系统告警（没有对应的领域事件），
 * 并按偏好写企业微信（定时推送所属产品的个人提醒通道）与邮件提醒。返回写入的站内通知数。
 */
export async function notifyScheduleAlertTx(tx: Tx, s: ScheduleRow, body: string, publicUrl: string, now: Date): Promise<number> {
  const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, s.orgId));
  if (!org) return 0;
  const admins = await tx
    .select({ id: members.id, email: members.email, wecomUserid: members.wecomUserid })
    .from(members)
    .where(and(inArray(members.orgRole, ['owner', 'admin']), eq(members.status, 'active'), eq(members.kind, 'human')));
  if (admins.length === 0) return 0;
  const prefs = await prefsForTx(tx, admins.map((x) => x.id));
  const title = `定时推送「${s.name}」`;
  const url = `/${org.slug}/settings/notifications?tab=schedules`;
  let created = 0;
  const outbound: OutboundItem[] = [];
  for (const m of admins) {
    const pref = prefs.get(m.id)!.system_alert;
    if (pref.inApp) {
      await tx.insert(memberNotifications).values({ orgId: s.orgId, memberId: m.id, eventId: null, kind: 'system_alert', subjectType: 'schedule', subjectId: s.id, title, body, url, actorMemberId: null, createdAt: now });
      created += 1;
    }
    if (pref.wecom || pref.email) {
      outbound.push({ productId: s.productId, memberId: m.id, email: m.email, wecomUserid: m.wecomUserid, viaWecom: pref.wecom, viaEmail: pref.email, actorName: null, body, title, url });
    }
  }
  if (outbound.length > 0) await dispatchPersonalTx(tx, s.orgId, outbound, publicUrl, now);
  return created;
}
