import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let readToken: string;

const GATED_WORKFLOW = {
  name: '准入流程',
  body: {
    states: [
      { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
      { key: 'done', label: '已上线', color: '#10b981', order: 2, group: '', category: 'completed' },
    ],
    initial: 'backlog',
    transitions: [
      { from: '*', to: 'backlog', conditions: [] },
      { from: '*', to: 'done', conditions: [] },
    ],
    actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
    checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
  },
};

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me;
  readToken = (
    await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me.memberId, name: '只读', scope: { products: 'all', access: 'read' } } })
  ).body.token;
});
afterAll(() => cleanup());

describe('迭代接口', () => {
  it('新建、重叠返回 409、列表、详情、修改、开始、范围对比', async () => {
    const created = await call(app, 'POST', '/orgs/acme/iterations', {
      session,
      body: { type: 'regular', productId, name: '迭代0701', startDate: '2026-07-01', endDate: '2026-07-15', milestones: [{ label: '发布', date: '2026-07-15' }] },
    });
    expect(created.status).toBe(201);
    const id = created.body.iteration.id as string;
    const overlap = await call(app, 'POST', '/orgs/acme/iterations', {
      session,
      body: { type: 'regular', productId, name: '重叠', startDate: '2026-07-10', endDate: '2026-07-20' },
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.message).toBe('与已有迭代时间重叠');

    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '批量下载' } })).body.requirement;
    const joined = await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { session, body: { iterationId: id } });
    expect(joined.body).toEqual({ iteration: { id, name: '迭代0701' } });

    const list = await call(app, 'GET', `/orgs/acme/iterations?product=${productId}`, { session });
    expect(list.body.iterations).toMatchObject([{ id, requirementCount: 1, milestones: [{ label: '发布', date: '2026-07-15' }] }]);
    const detail = await call(app, 'GET', `/orgs/acme/iterations/${id}`, { session });
    expect(detail.body.iteration.requirements).toMatchObject([{ displayKey: 'PAN-1', title: '批量下载' }]);
    const patched = await call(app, 'PATCH', `/orgs/acme/iterations/${id}`, { session, body: { name: '迭代0701A' } });
    expect(patched.body.iteration.name).toBe('迭代0701A');

    expect((await call(app, 'GET', `/orgs/acme/iterations/${id}/scope`, { session })).status).toBe(400);
    const started = await call(app, 'POST', `/orgs/acme/iterations/${id}/status`, { session, body: { to: 'active' } });
    expect(started.body.iteration).toMatchObject({ status: 'active', baselineEndDate: '2026-07-15' });
    const scope = await call(app, 'GET', `/orgs/acme/iterations/${id}/scope`, { session });
    expect(scope.body.scope).toMatchObject({ hasSnapshot: true, committedOpen: [{ displayKey: 'PAN-1' }], addedLater: [], removed: [] });
    expect((await call(app, 'POST', `/orgs/acme/iterations/${id}/status`, { session, body: { to: 'bogus' } })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/iterations/00000000-0000-0000-0000-000000000000', { session })).status).toBe(404);
  });

  it('加入迭代的条件未满足返回 412 和原因；管理员带原因可以强制加入', async () => {
    const wf = await call(app, 'POST', '/orgs/acme/workflows', { session, body: GATED_WORKFLOW });
    expect(wf.status).toBe(201);
    await call(app, 'PUT', `/orgs/acme/products/${productId}/workflow`, { session, body: { versionId: wf.body.version.id } });
    const it2 = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } })
    ).body.iteration.id;
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '回收站搜索' } })).body.requirement;
    const blocked = await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { session, body: { iterationId: it2 } });
    expect(blocked.status).toBe(412);
    expect(blocked.body.error).toEqual({ code: 'precondition_failed', message: '加入迭代的条件未满足', details: { unmet: ['「可行性」需为通过（当前：未开始）'] } });
    const detail = await call(app, 'GET', `/orgs/acme/requirements/${req.displayKey}`, { session });
    expect(detail.body.requirement.joinIterationUnmet).toMatchObject([{ message: '「可行性」需为通过（当前：未开始）' }]);
    const forced = await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { session, body: { iterationId: it2, force: true, reason: '线上问题' } });
    expect(forced.status).toBe(200);
    expect(forced.body.iteration.id).toBe(it2);
  });

  it('只读 Token 可以读取，不能新建迭代或加入迭代', async () => {
    expect((await call(app, 'GET', '/orgs/acme/iterations', { token: readToken })).status).toBe(200);
    const denied = await call(app, 'POST', '/orgs/acme/iterations', {
      token: readToken,
      body: { type: 'regular', productId, name: '越权', startDate: '2026-12-01', endDate: '2026-12-10' },
    });
    expect(denied.status).toBe(403);
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '只读测试' } })).body.requirement;
    expect((await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { token: readToken, body: { iterationId: null } })).status).toBe(403);
  });

  it('删除规划中的空迭代返回 204，之后查不到', async () => {
    const id = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '临时迭代', startDate: '2027-01-01', endDate: '2027-01-10' } })
    ).body.iteration.id;
    expect((await call(app, 'DELETE', `/orgs/acme/iterations/${id}`, { session })).status).toBe(204);
    expect((await call(app, 'GET', `/orgs/acme/iterations/${id}`, { session })).status).toBe(404);
  });
});

describe('发布版本接口', () => {
  it('新建、修改、标记发布、按迭代列出、关联与解除需求', async () => {
    const fields = (await call(app, 'GET', '/orgs/acme/fields', { session })).body.fields;
    const platform = fields.find((f: { key: string }) => f.key === 'platform');
    const pc = (await call(app, 'POST', `/orgs/acme/fields/${platform.id}/options`, { session, body: { label: 'PC客户端' } })).body.option.id;
    const iterationId = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0901', startDate: '2026-09-01', endDate: '2026-09-14' } })
    ).body.iteration.id;
    const created = await call(app, 'POST', '/orgs/acme/releases', {
      session,
      body: { productId, versionName: '3.2.0', platformOptionId: pc, iterationId, plannedDate: '2026-09-14' },
    });
    expect(created.status).toBe(201);
    const id = created.body.release.id;
    expect(created.body.release).toMatchObject({ baselineDate: '2026-09-14', platform: { label: 'PC客户端' } });
    const patched = await call(app, 'PATCH', `/orgs/acme/releases/${id}`, { session, body: { plannedDate: '2026-09-20' } });
    expect(patched.body.release).toMatchObject({ plannedDate: '2026-09-20', baselineDate: '2026-09-14' });
    expect((await call(app, 'GET', '/orgs/acme/releases', { session })).status).toBe(400);
    expect((await call(app, 'GET', `/orgs/acme/releases?iteration=${iterationId}`, { session })).body.releases).toMatchObject([{ id }]);

    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '分享统计' } })).body.requirement;
    expect((await call(app, 'PUT', `/orgs/acme/releases/${id}/requirements/${req.id}`, { session })).status).toBe(204);
    expect((await call(app, 'GET', `/orgs/acme/releases?product=${productId}`, { session })).body.releases[0].requirementCount).toBe(1);
    expect((await call(app, 'DELETE', `/orgs/acme/releases/${id}/requirements/${req.id}`, { session })).status).toBe(204);

    const released = await call(app, 'POST', `/orgs/acme/releases/${id}/released`, { session });
    expect(released.body.release.status).toBe('released');
    expect((await call(app, 'POST', `/orgs/acme/releases/${id}/released`, { session })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/releases', { token: readToken, body: { productId, versionName: 'x', plannedDate: '2026-09-30' } })).status).toBe(403);
  });
});
