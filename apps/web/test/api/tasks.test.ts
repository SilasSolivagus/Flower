import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let memberId: string;
let readToken: string;
let iterationId: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  memberId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
  // 2026-01-05 周一至 01-16 周五，共 10 个工作日；运行测试时迭代已结束，理论进度为 100
  iterationId = (
    await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0105', startDate: '2026-01-05', endDate: '2026-01-16' } })
  ).body.iteration.id;
});
afterAll(() => cleanup());

describe('任务接口', () => {
  it('新建、修改、甘特与概览、按需求与按人查询、删除', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '上传提速' } })).body.requirement;
    const created = await call(app, 'POST', '/orgs/acme/tasks', {
      session,
      body: { iterationId, requirementId: req.id, title: '前端开发', assigneeMemberId: memberId, planStart: '2026-01-05', planDays: 2 },
    });
    expect(created.status).toBe(201);
    const id = created.body.task.id as string;
    expect(created.body.task).toMatchObject({ requirement: { displayKey: 'PAN-1' }, planDays: 2, progress: 100 });

    const manual = await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '联调', flag: 'attention', progress: 20 } });
    expect(manual.body.task).toMatchObject({ requirement: null, flag: 'attention', progress: 20 });

    const patched = await call(app, 'PATCH', `/orgs/acme/tasks/${id}`, { session, body: { alias: '前端', note: '等设计稿', progress: 40 } });
    expect(patched.body.task).toMatchObject({ alias: '前端', note: '等设计稿', progressOverride: 40, progress: 40 });

    const gantt = (await call(app, 'GET', `/orgs/acme/iterations/${iterationId}/gantt`, { session })).body.gantt;
    expect(gantt.workdays).toHaveLength(10);
    expect(gantt.overview).toMatchObject({ rowCount: 2, deferred: 1, overall: 40, expected: 100, behind: 60 });
    expect(gantt.canAddTask).toBe(true);

    expect((await call(app, 'GET', `/orgs/acme/requirements/${req.id}/tasks`, { session })).body.tasks).toMatchObject([{ id }]);
    const person = await call(app, 'GET', `/orgs/acme/members/${memberId}/tasks`, { session });
    expect(person.body).toMatchObject({ member: { id: memberId }, tasks: [{ id, iteration: { id: iterationId, name: '迭代0105', status: 'planning' } }] });

    const manualId = manual.body.task.id as string;
    expect((await call(app, 'DELETE', `/orgs/acme/tasks/${manualId}`, { session })).status).toBe(204);
    expect((await call(app, 'PATCH', `/orgs/acme/tasks/${manualId}`, { session, body: { title: '已删除' } })).status).toBe(404);
  });

  it('参数错误返回 400 与中文原因；第 11 个重点返回 409', async () => {
    expect((await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '坏标记', flag: 'bogus' } })).status).toBe(400);
    const bad = await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '坏工期', planDays: 0.2 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'invalid', message: '工期以半天为单位，范围 0.5–365 天' });
    for (let i = 1; i <= 10; i++) {
      expect((await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: `重点${i}`, starred: true } })).status).toBe(201);
    }
    const over = await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '重点11', starred: true } });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toBe('每个迭代最多 10 个重点任务');
  });

  it('只读 Token 可以读取甘特，不能新建、修改、删除任务', async () => {
    const id = (await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '只读测试' } })).body.task.id;
    expect((await call(app, 'GET', `/orgs/acme/iterations/${iterationId}/gantt`, { token: readToken })).status).toBe(200);
    expect((await call(app, 'POST', '/orgs/acme/tasks', { token: readToken, body: { iterationId, title: '越权' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `/orgs/acme/tasks/${id}`, { token: readToken, body: { title: '越权' } })).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/tasks/${id}`, { token: readToken })).status).toBe(403);
  });

  it('访客按人查询任务只能查自己的，查别人返回 403', async () => {
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'guest@example.com', orgRole: 'guest' } });
    const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '访客', password: 'password123' } });
    const guestSession = sessionFrom(accept.res);
    expect((await call(app, 'GET', `/orgs/acme/members/${memberId}/tasks`, { session: guestSession })).status).toBe(403);
  });
});
