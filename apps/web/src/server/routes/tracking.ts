import {
  AppError,
  createProgress,
  createWorkItem,
  createWorkItemBlocker,
  deleteProgress,
  deleteWorkItem,
  getTracking,
  getTrackingSettings,
  getWorkItemByKey,
  joinTracking,
  leaveTracking,
  listProgress,
  pauseRequirement,
  pauseWorkItem,
  resumeRequirement,
  resumeWorkItem,
  setRequirementExpectedDate,
  setWorkItemStatus,
  type TrackingFilter,
  updateProgress,
  updateTrackingSettings,
  updateWorkItem,
  WORK_ITEM_STATUSES,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';
import { idParam } from './notifications';

const uuid = z.string().uuid();
const flag = z.literal('1').optional();
const trackingQuery = z.object({ product: uuid.optional(), owner: uuid.optional(), type: uuid.optional(), paused: flag, blocked: flag, done: flag });
const date = z.string().max(20).nullable();
const pauseBody = z.object({ reason: z.string().max(1000) });
const progressBody = z.object({
  body: z.string().max(10_000),
  nextStep: z.string().max(2000).nullable().optional(),
  followerMemberId: uuid.nullable().optional(),
  expectedDate: date.optional(),
});
const progressPatch = z.object({ body: z.string().max(10_000).optional(), nextStep: z.string().max(2000).nullable().optional(), followerMemberId: uuid.nullable().optional() });
const workItemFields = {
  description: z.string().max(60_000).optional(),
  productId: uuid.nullable().optional(),
  ownerMemberId: uuid.nullable().optional(),
  workTypeOptionId: uuid.nullable().optional(),
  startedOn: date.optional(),
  expectedDate: date.optional(),
};
const settingsBody = z.object({ warnDays: z.number(), alertDays: z.number(), staleUpdateDays: z.number() });

/** 地址栏筛选 → 服务参数；格式不对时报 400（合法 UUID 但看不到或不存在的值由服务返回空结果）。 */
function trackingFilter(c: Context): TrackingFilter {
  const q = trackingQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError('invalid', '筛选参数无效');
  const { product, owner, type, paused, blocked, done } = q.data;
  return { productId: product, ownerId: owner, typeOptionId: type, paused: !!paused, blocked: !!blocked, includeDone: !!done };
}

export function registerTrackingRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/tracking', async (c) => c.json({ tracking: await getTracking(deps.db, c.get('actor'), trackingFilter(c)) }));

  app.get('/orgs/:org/tracking-settings', async (c) => c.json({ settings: await getTrackingSettings(deps.db, c.get('actor')) }));

  app.put('/orgs/:org/tracking-settings', async (c) => {
    const body = await readJson(c, settingsBody);
    return c.json({ settings: await updateTrackingSettings(deps.db, c.get('actor'), body) });
  });

  // 需求的跟进设置
  app.put('/orgs/:org/requirements/:id/tracking', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, z.object({ tracking: z.boolean() }));
    const actor = c.get('actor');
    return c.json({ tracking: body.tracking ? await joinTracking(deps.db, actor, id) : await leaveTracking(deps.db, actor, id) });
  });

  app.put('/orgs/:org/requirements/:id/expected-date', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, z.object({ expectedDate: date }));
    return c.json({ tracking: await setRequirementExpectedDate(deps.db, c.get('actor'), id, body.expectedDate) });
  });

  app.post('/orgs/:org/requirements/:id/pause', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, pauseBody);
    return c.json({ tracking: await pauseRequirement(deps.db, c.get('actor'), id, body) });
  });

  app.post('/orgs/:org/requirements/:id/resume', async (c) => c.json({ tracking: await resumeRequirement(deps.db, c.get('actor'), idParam(c, 'id', '需求不存在')) }));

  app.get('/orgs/:org/requirements/:id/progress', async (c) =>
    c.json({ progress: await listProgress(deps.db, c.get('actor'), { type: 'requirement', id: idParam(c, 'id', '需求不存在') }) }),
  );

  app.post('/orgs/:org/requirements/:id/progress', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, progressBody);
    return c.json({ progress: await createProgress(deps.db, c.get('actor'), { type: 'requirement', id }, body) }, 201);
  });

  // 工作项
  app.post('/orgs/:org/work-items', async (c) => {
    const body = await readJson(c, z.object({ title: z.string().max(1000), ...workItemFields }));
    return c.json({ workItem: await createWorkItem(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/work-items/:key', async (c) => c.json({ workItem: await getWorkItemByKey(deps.db, c.get('actor'), c.req.param('key')) }));

  app.patch('/orgs/:org/work-items/:id', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, z.object({ title: z.string().max(1000).optional(), ...workItemFields }));
    return c.json({ workItem: await updateWorkItem(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/work-items/:id', async (c) => {
    await deleteWorkItem(deps.db, c.get('actor'), idParam(c, 'id', '工作项不存在'));
    return c.body(null, 204);
  });

  app.post('/orgs/:org/work-items/:id/status', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, z.object({ status: z.enum(WORK_ITEM_STATUSES) }));
    return c.json({ workItem: await setWorkItemStatus(deps.db, c.get('actor'), id, body.status) });
  });

  app.post('/orgs/:org/work-items/:id/pause', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, pauseBody);
    return c.json({ workItem: await pauseWorkItem(deps.db, c.get('actor'), id, body) });
  });

  app.post('/orgs/:org/work-items/:id/resume', async (c) => c.json({ workItem: await resumeWorkItem(deps.db, c.get('actor'), idParam(c, 'id', '工作项不存在')) }));

  app.get('/orgs/:org/work-items/:id/progress', async (c) =>
    c.json({ progress: await listProgress(deps.db, c.get('actor'), { type: 'work_item', id: idParam(c, 'id', '工作项不存在') }) }),
  );

  app.post('/orgs/:org/work-items/:id/progress', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, progressBody);
    return c.json({ progress: await createProgress(deps.db, c.get('actor'), { type: 'work_item', id }, body) }, 201);
  });

  app.post('/orgs/:org/work-items/:id/blockers', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, z.object({ description: z.string().max(500), ownerMemberId: uuid.nullable().optional() }));
    return c.json({ blocker: await createWorkItemBlocker(deps.db, c.get('actor'), id, body) }, 201);
  });

  // 进展记录
  app.patch('/orgs/:org/progress/:id', async (c) => {
    const id = idParam(c, 'id', '进展记录不存在');
    const body = await readJson(c, progressPatch);
    return c.json({ progress: await updateProgress(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/progress/:id', async (c) => {
    await deleteProgress(deps.db, c.get('actor'), idParam(c, 'id', '进展记录不存在'));
    return c.body(null, 204);
  });
}
