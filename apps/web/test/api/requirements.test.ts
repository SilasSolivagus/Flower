import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let p1: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const fields = (await call(app, 'GET', '/orgs/acme/fields', { session })).body.fields;
  p1 = fields.find((f: { key: string }) => f.key === 'priority').options.find((o: { key: string }) => o.key === 'p1').id;
});
afterAll(() => cleanup());

describe('需求接口', () => {
  it('创建、列表筛选与按编号查看详情', async () => {
    const created = await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, {
      session,
      body: { title: '离线下载支持磁力链接', fields: { priority: [p1] } },
    });
    expect(created.status).toBe(201);
    expect(created.body.requirement).toMatchObject({ displayKey: 'PAN-1', priority: { label: 'P1' } });
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '相册按地点归类' } });

    const list = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?priority=${p1}&sort=number`, { session });
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: { title: string }) => r.title)).toEqual(['离线下载支持磁力链接']);
    expect(list.body.stateCounts).toEqual({ backlog: 1 });
    const byQ = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?q=${encodeURIComponent('相册')}`, { session });
    expect(byQ.body.total).toBe(1);

    const detail = await call(app, 'GET', '/orgs/acme/requirements/PAN-1', { session });
    expect(detail.status).toBe(200);
    expect(detail.body.requirement).toMatchObject({ title: '离线下载支持磁力链接', stateKey: 'backlog', myRole: 'admin' });
    expect(detail.body.requirement.transitions.map((x: { to: string }) => x.to)).toContain('todo');
  });

  it('修改、设置字段、流转和评论', async () => {
    const d = (await call(app, 'GET', '/orgs/acme/requirements/PAN-2', { session })).body.requirement;
    const patched = await call(app, 'PATCH', `/orgs/acme/requirements/${d.id}`, { session, body: { title: '相册按地点和时间归类' } });
    expect(patched.body.requirement.title).toBe('相册按地点和时间归类');
    const f = await call(app, 'PUT', `/orgs/acme/requirements/${d.id}/fields/priority`, { session, body: { optionIds: [p1] } });
    expect(f.body.options.map((o: { label: string }) => o.label)).toEqual(['P1']);
    const tr = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/transitions`, { session, body: { to: 'todo' } });
    expect(tr.body).toEqual({ stateKey: 'todo' });
    const bad = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/transitions`, { session, body: { to: 'todo' } });
    expect(bad.status).toBe(400);
    const c = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/comments`, { session, body: { body: '需要和相册团队确认' } });
    expect(c.status).toBe(201);
    const list = await call(app, 'GET', `/orgs/acme/requirements/${d.id}/comments`, { session });
    expect(list.body.comments).toHaveLength(1);
    const read = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/comments/read`, { session });
    expect(read.body).toEqual({ marked: 0 });
  });

  it('related=me 与 owner、requester 互斥，非法取值返回 400', async () => {
    const bad = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?related=foo`, { session });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'INVALID_RELATED', message: 'related 只能是 me' });

    const empty = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?related=`, { session });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_RELATED');

    const withOwner = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?related=me&owner=not-a-member`, { session });
    expect(withOwner.status).toBe(400);
    expect(withOwner.body.error).toMatchObject({ code: 'RELATED_CONFLICT', message: 'related=me 与 owner/requester 不能同时传' });

    const withRequester = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?related=me&requester=not-a-member`, { session });
    expect(withRequester.status).toBe(400);
    expect(withRequester.body.error.code).toBe('RELATED_CONFLICT');

    const mine = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?related=me`, { session });
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(0);

    const all = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements`, { session });
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThan(0);
  });

  it('节点与迭代列表、不存在的需求返回 404', async () => {
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/nodes`, { session })).body).toEqual({ nodes: [] });
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/iterations`, { session })).body).toEqual({ iterations: [] });
    expect((await call(app, 'GET', '/orgs/acme/requirements/PAN-404', { session })).status).toBe(404);
  });
});
