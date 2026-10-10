import {
  AppError,
  CHANNEL_KINDS,
  createChannel,
  createMessageTemplate,
  createRule,
  createSchedule,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  deleteChannel,
  deleteMessageTemplate,
  deleteRule,
  deleteSchedule,
  listChannels,
  listDeliveries,
  listMessageTemplates,
  listProductChannelOptions,
  listRules,
  listSchedules,
  resendDelivery,
  RULE_MODES,
  runScheduleNow,
  SCHEDULE_SOURCES,
  sendTestMessage,
  TEMPLATE_FORMATS,
  updateChannel,
  updateMessageTemplate,
  updateRule,
  updateSchedule,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const uuid = z.string().uuid();
const ids = z.array(uuid).max(100);
const record = z.record(z.string(), z.unknown());

/** 校验路径参数是合法的 UUID，否则报 400（而不是让 Postgres 的 22P02 落到 404）。 */
function idParam(c: Context, name: string, message: string): string {
  const r = uuid.safeParse(c.req.param(name));
  if (!r.success) throw new AppError('invalid', message);
  return r.data;
}

const configPatch = z
  .object({
    url: z.string().max(2000),
    secret: z.string().max(200),
    clearSecret: z.boolean(),
    host: z.string().max(255),
    port: z.number().int(),
    secure: z.boolean(),
    user: z.string().max(255),
    pass: z.string().max(500),
    from: z.string().max(255),
    to: z.array(z.string().max(255)).max(50),
  })
  .partial();

/** 过滤条件只校验形状，取值由服务层校验（parseRuleFilter）。 */
const list = z.array(z.string().max(100)).max(50);
const ruleFilter = z.object({ states: list, priorities: list, nodeIds: list, documentStatuses: list, fields: list }).partial();

const ruleBody = z.object({
  name: z.string(),
  eventTypes: z.array(z.string()).max(20),
  filter: ruleFilter.optional(),
  channelIds: ids.optional(),
  templateId: uuid.nullable().optional(),
  mode: z.enum(RULE_MODES).optional(),
  digestScheduleId: uuid.nullable().optional(),
  enabled: z.boolean().optional(),
});

const scheduleBody = z.object({
  name: z.string(),
  cron: z.string().max(100),
  timezone: z.string().max(64).optional(),
  sourceConfig: record.optional(),
  channelIds: ids,
  templateId: uuid.nullable().optional(),
  enabled: z.boolean().optional(),
  failThreshold: z.number().int().optional(),
});

const deliveryQuery = z.object({
  channel: uuid.optional(),
  kind: z.enum(DELIVERY_KINDS).optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerNotificationRoutes(app: App, deps: ApiDeps): void {
  // 通道（组织管理员）
  app.get('/orgs/:org/notification-channels', async (c) => c.json({ channels: await listChannels(deps.db, c.get('actor'), deps.notify) }));

  app.post('/orgs/:org/notification-channels', async (c) => {
    const body = await readJson(
      c,
      z.object({
        kind: z.enum(CHANNEL_KINDS),
        name: z.string(),
        groupLabel: z.string().nullable().optional(),
        config: record,
        rateLimitPerMin: z.number().int().optional(),
        allowedProductIds: ids.optional(),
        enabled: z.boolean().optional(),
      }),
    );
    return c.json({ channel: await createChannel(deps.db, c.get('actor'), body, deps.notify) }, 201);
  });

  app.patch('/orgs/:org/notification-channels/:id', async (c) => {
    const id = idParam(c, 'id', '通道无效');
    const body = await readJson(
      c,
      z.object({
        name: z.string().optional(),
        groupLabel: z.string().nullable().optional(),
        config: configPatch.optional(),
        rateLimitPerMin: z.number().int().optional(),
        allowedProductIds: ids.optional(),
        enabled: z.boolean().optional(),
      }),
    );
    return c.json({ channel: await updateChannel(deps.db, c.get('actor'), id, body, deps.notify) });
  });

  app.delete('/orgs/:org/notification-channels/:id', async (c) => {
    await deleteChannel(deps.db, c.get('actor'), idParam(c, 'id', '通道无效'));
    return c.body(null, 204);
  });

  app.post('/orgs/:org/notification-channels/:id/test', async (c) =>
    c.json({ delivery: await sendTestMessage(deps.db, c.get('actor'), idParam(c, 'id', '通道无效'), deps.notify) }),
  );

  app.get('/orgs/:org/products/:id/notification-channels', async (c) =>
    c.json({ channels: await listProductChannelOptions(deps.db, c.get('actor'), idParam(c, 'id', '产品无效')) }),
  );

  // 消息模板（读：非访客；写：组织管理员）
  app.get('/orgs/:org/message-templates', async (c) => c.json({ templates: await listMessageTemplates(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/message-templates', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), format: z.enum(TEMPLATE_FORMATS), body: z.string().max(20_000) }));
    return c.json({ template: await createMessageTemplate(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/message-templates/:id', async (c) => {
    const id = idParam(c, 'id', '模板无效');
    const body = await readJson(c, z.object({ name: z.string().optional(), format: z.enum(TEMPLATE_FORMATS).optional(), body: z.string().max(20_000).optional() }));
    return c.json({ template: await updateMessageTemplate(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/message-templates/:id', async (c) => {
    await deleteMessageTemplate(deps.db, c.get('actor'), idParam(c, 'id', '模板无效'));
    return c.body(null, 204);
  });

  // 事件规则（产品管理员）
  app.get('/orgs/:org/products/:id/notification-rules', async (c) => c.json({ rules: await listRules(deps.db, c.get('actor'), idParam(c, 'id', '产品无效')) }));

  app.post('/orgs/:org/products/:id/notification-rules', async (c) => {
    const productId = idParam(c, 'id', '产品无效');
    const body = await readJson(c, ruleBody);
    return c.json({ rule: await createRule(deps.db, c.get('actor'), productId, body) }, 201);
  });

  app.patch('/orgs/:org/notification-rules/:id', async (c) => {
    const id = idParam(c, 'id', '规则无效');
    const body = await readJson(c, ruleBody.partial());
    return c.json({ rule: await updateRule(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/notification-rules/:id', async (c) => {
    await deleteRule(deps.db, c.get('actor'), idParam(c, 'id', '规则无效'));
    return c.body(null, 204);
  });

  // 定时推送（本产品管理员；不带 product 时列出全部，需要组织管理员）
  app.get('/orgs/:org/notification-schedules', async (c) => {
    const product = c.req.query('product');
    if (product !== undefined && !uuid.safeParse(product).success) throw new AppError('invalid', '产品无效');
    return c.json({ schedules: await listSchedules(deps.db, c.get('actor'), { productId: product }) });
  });

  app.post('/orgs/:org/notification-schedules', async (c) => {
    const body = await readJson(c, scheduleBody.extend({ productId: uuid, source: z.enum(SCHEDULE_SOURCES) }));
    return c.json({ schedule: await createSchedule(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/notification-schedules/:id', async (c) => {
    const id = idParam(c, 'id', '定时推送无效');
    const body = await readJson(c, scheduleBody.partial());
    return c.json({ schedule: await updateSchedule(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/notification-schedules/:id', async (c) => {
    await deleteSchedule(deps.db, c.get('actor'), idParam(c, 'id', '定时推送无效'));
    return c.body(null, 204);
  });

  /** 立即执行：会话或有写权限的 API Token（取代 push 的 /trigger/:id）。 */
  app.post('/orgs/:org/notification-schedules/:id/run', async (c) =>
    c.json({ result: await runScheduleNow(deps.db, c.get('actor'), idParam(c, 'id', '定时推送无效'), deps.notify) }),
  );

  // 发送记录（组织管理员）
  app.get('/orgs/:org/notification-deliveries', async (c) => {
    const parsed = deliveryQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError('invalid', '查询参数有误');
    const { channel, ...rest } = parsed.data;
    return c.json(await listDeliveries(deps.db, c.get('actor'), { channelId: channel, ...rest }));
  });

  app.post('/orgs/:org/notification-deliveries/:id/resend', async (c) =>
    c.json({ delivery: await resendDelivery(deps.db, c.get('actor'), idParam(c, 'id', '发送记录无效')) }, 201),
  );
}
