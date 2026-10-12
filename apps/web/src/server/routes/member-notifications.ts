import {
  AppError,
  countMyUnread,
  getNotificationSettings,
  getPersonalChannel,
  getPersonalEmailChannel,
  getSubscription,
  listMentionMembers,
  listMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markSubjectNotificationsRead,
  MEMBER_NOTIFICATION_KINDS,
  NOTIFICATION_SUBJECT_TYPES,
  setNotificationPref,
  setPersonalChannel,
  setPersonalEmailChannel,
  setSubscription,
  SUBSCRIPTION_SUBJECT_TYPES,
  type SubscriptionSubject,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const uuid = z.string().uuid();

/** 校验路径参数是合法的 UUID，否则报 400（而不是让 Postgres 的 22P02 落到 404）。 */
function idParam(c: Context, name: string, message: string): string {
  const r = uuid.safeParse(c.req.param(name));
  if (!r.success) throw new AppError('invalid', message);
  return r.data;
}

function subjectParam(c: Context): SubscriptionSubject {
  const type = z.enum(SUBSCRIPTION_SUBJECT_TYPES).safeParse(c.req.param('type'));
  if (!type.success) throw new AppError('invalid', '只能关注需求或 PRD');
  return { type: type.data, id: idParam(c, 'id', '关注的对象不存在') };
}

const listQuery = z.object({
  filter: z.enum(['all', 'unread', 'mentioned']).optional(),
  kind: z.enum(MEMBER_NOTIFICATION_KINDS).optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const prefBody = z.object({ inApp: z.boolean(), wecom: z.boolean(), email: z.boolean() });
const channelBody = z.object({ channelId: uuid.nullable() });

export function registerMemberNotificationRoutes(app: App, deps: ApiDeps): void {
  // 站内通知（本人）
  app.get('/orgs/:org/notifications', async (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) throw new AppError('invalid', '查询参数有误');
    return c.json(await listMyNotifications(deps.db, c.get('actor'), q.data));
  });

  app.get('/orgs/:org/notifications/unread-count', async (c) => c.json({ count: await countMyUnread(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/notifications/read-all', async (c) => c.json({ count: await markAllNotificationsRead(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/notifications/read-subject', async (c) => {
    const body = await readJson(c, z.object({ subjectType: z.enum(NOTIFICATION_SUBJECT_TYPES), subjectId: uuid }));
    return c.json({ count: await markSubjectNotificationsRead(deps.db, c.get('actor'), { type: body.subjectType, id: body.subjectId }) });
  });

  app.post('/orgs/:org/notifications/:id/read', async (c) => {
    await markNotificationRead(deps.db, c.get('actor'), idParam(c, 'id', '通知不存在'));
    return c.body(null, 204);
  });

  // 关注
  app.get('/orgs/:org/subscriptions/:type/:id', async (c) => c.json({ subscription: await getSubscription(deps.db, c.get('actor'), subjectParam(c)) }));

  app.put('/orgs/:org/subscriptions/:type/:id', async (c) => {
    const subject = subjectParam(c);
    const body = await readJson(c, z.object({ following: z.boolean() }));
    return c.json({ subscription: await setSubscription(deps.db, c.get('actor'), subject, body.following) });
  });

  // 个人偏好
  app.get('/orgs/:org/me/notification-settings', async (c) => c.json({ settings: await getNotificationSettings(deps.db, c.get('actor')) }));

  app.put('/orgs/:org/me/notification-prefs/:kind', async (c) => {
    const kind = z.enum(MEMBER_NOTIFICATION_KINDS).safeParse(c.req.param('kind'));
    if (!kind.success) throw new AppError('invalid', '通知类型不存在');
    const body = await readJson(c, prefBody);
    return c.json({ settings: await setNotificationPref(deps.db, c.get('actor'), kind.data, body) });
  });

  // @ 候选成员
  app.get('/orgs/:org/products/:id/mention-members', async (c) => c.json({ members: await listMentionMembers(deps.db, c.get('actor'), idParam(c, 'id', '产品不存在')) }));

  // 个人提醒通道（产品）与个人通知邮件通道（组织）
  app.get('/orgs/:org/products/:id/personal-channel', async (c) => c.json(await getPersonalChannel(deps.db, c.get('actor'), idParam(c, 'id', '产品不存在'))));

  app.put('/orgs/:org/products/:id/personal-channel', async (c) => {
    const productId = idParam(c, 'id', '产品不存在');
    const body = await readJson(c, channelBody);
    return c.json(await setPersonalChannel(deps.db, c.get('actor'), productId, body.channelId));
  });

  app.get('/orgs/:org/personal-email-channel', async (c) => c.json(await getPersonalEmailChannel(deps.db, c.get('actor'))));

  app.put('/orgs/:org/personal-email-channel', async (c) => {
    const body = await readJson(c, channelBody);
    return c.json(await setPersonalEmailChannel(deps.db, c.get('actor'), body.channelId));
  });
}
