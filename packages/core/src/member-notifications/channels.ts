import { and, eq, isNull } from 'drizzle-orm';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, organizations, products } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { usableChannelsTx } from '../notifications/channels';

export type PersonalChannelSetting = { channelId: string | null };

export async function getPersonalChannel(db: Db, actor: Actor, productId: string): Promise<PersonalChannelSetting> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [p] = await tx.select({ channelId: products.personalChannelId }).from(products).where(eq(products.id, productId));
    return { channelId: p?.channelId ?? null };
  });
}

/** 产品的个人提醒通道：只能是对本产品可用、已启用的企业微信机器人通道；为空表示不发企业微信个人提醒。 */
export async function setPersonalChannel(db: Db, actor: Actor, productId: string, channelId: string | null): Promise<PersonalChannelSetting> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [cur] = await tx
      .select({ channelId: products.personalChannelId })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)));
    if (!cur) throw new AppError('not_found', '产品不存在');
    if (channelId) {
      const [ch] = (await usableChannelsTx(tx, [channelId], productId)).filter((c) => c.kind === 'wecom_robot');
      if (!ch) throw new AppError('invalid', '个人提醒通道只能选择对本产品可用、已启用的企业微信机器人通道');
    }
    if (cur.channelId !== channelId) {
      await tx.update(products).set({ personalChannelId: channelId }).where(eq(products.id, productId));
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId,
        type: 'product.personal_channel_set',
        subjectType: 'product',
        subjectId: productId,
        actor,
        payload: { changes: [{ field: 'personalChannelId', old: cur.channelId, new: channelId }] },
      });
    }
    return { channelId };
  });
}

export async function getPersonalEmailChannel(db: Db, actor: Actor): Promise<PersonalChannelSetting> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [o] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, actor.orgId));
    return { channelId: o?.channelId ?? null };
  });
}

/** 组织的个人通知邮件通道：只能是启用的邮件通道；收件地址为成员邮箱。 */
export async function setPersonalEmailChannel(db: Db, actor: Actor, channelId: string | null): Promise<PersonalChannelSetting> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, actor.orgId));
    if (channelId) {
      const [ch] = await tx
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.kind, 'email'), eq(notificationChannels.enabled, true)));
      if (!ch) throw new AppError('invalid', '个人通知邮件通道只能选择已启用的邮件通道');
    }
    const old = cur?.channelId ?? null;
    if (old !== channelId) {
      await tx.update(organizations).set({ personalEmailChannelId: channelId }).where(eq(organizations.id, actor.orgId));
      await recordEvent(tx, {
        orgId: actor.orgId,
        type: 'organization.personal_email_channel_set',
        subjectType: 'organization',
        subjectId: actor.orgId,
        actor,
        payload: { changes: [{ field: 'personalEmailChannelId', old, new: channelId }] },
      });
    }
    return { channelId };
  });
}
