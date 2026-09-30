import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let memberId: string;
let readToken: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  memberId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
});
afterAll(() => cleanup());

describe('需求分配接口', () => {
  it('新增返回 201，重复返回 409，详情带分配 id，删除返回 204；只读 Token 返回 403', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '上传提速' } })).body.requirement;
    const tags = (await call(app, 'GET', '/orgs/acme/function-tags', { session })).body.tags as Array<{ id: string; name: string }>;
    const design = tags.find((x) => x.name === '设计')!.id;
    const body = { memberId, functionTagId: design };
    const created = await call(app, 'POST', `/orgs/acme/requirements/${req.id}/assignments`, { session, body });
    expect(created.status).toBe(201);
    const dup = await call(app, 'POST', `/orgs/acme/requirements/${req.id}/assignments`, { session, body });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('已经有相同的分配');
    const detail = (await call(app, 'GET', `/orgs/acme/requirements/${req.displayKey}`, { session })).body.requirement;
    expect(detail.assignments).toMatchObject([{ id: created.body.assignment.id, functionTag: { name: '设计' } }]);
    expect((await call(app, 'POST', `/orgs/acme/requirements/${req.id}/assignments`, { token: readToken, body })).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/assignments/${created.body.assignment.id}`, { token: readToken })).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/assignments/${created.body.assignment.id}`, { session })).status).toBe(204);
  });
});
