import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
});
afterAll(() => cleanup());

describe('组织与产品', () => {
  it('查看组织；非成员访问别的组织得到 404', async () => {
    const r = await call(app, 'GET', '/orgs/acme', { session });
    expect(r.body).toMatchObject({ org: { slug: 'acme' }, me: { orgRole: 'owner' } });
    expect((await call(app, 'GET', '/orgs/other', { session })).status).toBe(404);
    expect((await call(app, 'GET', '/orgs/acme')).status).toBe(401);
  });

  it('创建与列出产品', async () => {
    const c = await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } });
    expect(c.status).toBe(201);
    productId = c.body.product.id;
    const l = await call(app, 'GET', '/orgs/acme/products', { session });
    expect(l.body.products.map((p: { key: string }) => p.key)).toEqual(['PAN']);
  });
});

describe('成员与邀请', () => {
  it('登记无账号成员、分配职能标签', async () => {
    const m = await call(app, 'POST', '/orgs/acme/members', { session, body: { displayName: '王总' } });
    expect(m.status).toBe(201);
    const tags = await call(app, 'GET', '/orgs/acme/function-tags', { session });
    const pm = tags.body.tags.find((x: { name: string }) => x.name === '产品经理');
    const set = await call(app, 'PUT', `/orgs/acme/members/${m.body.member.id}/function-tags`, { session, body: { tagIds: [pm.id] } });
    expect(set.body.member.functionTagIds).toEqual([pm.id]);
  });

  it('发出邀请，新用户凭链接注册并加入，随后可以访问组织', async () => {
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'new@example.com', orgRole: 'member' } });
    expect(inv.status).toBe(201);
    expect(inv.body.link).toBe(`http://localhost:3000/invite/${inv.body.token}`);

    const preview = await call(app, 'GET', `/invitations/${inv.body.token}`);
    expect(preview.body).toMatchObject({ orgSlug: 'acme', status: 'pending', accountExists: false });

    const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '新人', password: 'password123' } });
    expect(accept.status).toBe(200);
    const newSession = sessionFrom(accept.res);
    const products = await call(app, 'GET', '/orgs/acme/products', { session: newSession });
    expect(products.body.products[0].myRole).toBe('editor');
    expect((await call(app, 'POST', '/orgs/acme/products', { session: newSession, body: { name: 'x', key: 'XX' } })).status).toBe(403);
  });

  it('未登录且未提供姓名密码时接受邀请失败', async () => {
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'b@example.com', orgRole: 'guest' } });
    const r = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: {} });
    expect(r.status).toBe(400);
  });
});

describe('API Token', () => {
  it('Agent 只读 Token 只能读指定产品，不能写', async () => {
    const agent = await call(app, 'POST', '/orgs/acme/agents', { session, body: { displayName: 'PRD 助手' } });
    const issued = await call(app, 'POST', '/orgs/acme/tokens', {
      session,
      body: { memberId: agent.body.member.id, name: 'Claude Code', scope: { products: [productId], access: 'read' } },
    });
    expect(issued.status).toBe(201);
    const token: string = issued.body.token;

    const read = await call(app, 'GET', `/orgs/acme/products/${productId}`, { token });
    expect(read.body.product.myRole).toBe('viewer');
    expect((await call(app, 'PATCH', `/orgs/acme/products/${productId}`, { token, body: { name: '改名' } })).status).toBe(403);
    expect((await call(app, 'GET', '/orgs/other/products', { token })).status).toBe(404);

    await call(app, 'DELETE', `/orgs/acme/tokens/${issued.body.record.id}`, { session });
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}`, { token })).status).toBe(401);
  });

  it('产品角色覆盖', async () => {
    const guest = await call(app, 'POST', '/orgs/acme/members', { session, body: { displayName: '外部顾问' } });
    const id = guest.body.member.id;
    await call(app, 'PATCH', `/orgs/acme/members/${id}`, { session, body: { orgRole: 'guest' } });
    const set = await call(app, 'PUT', `/orgs/acme/products/${productId}/roles/${id}`, { session, body: { role: 'viewer' } });
    expect(set.status).toBe(204);
    const roles = await call(app, 'GET', `/orgs/acme/products/${productId}/roles`, { session });
    expect(roles.body.roles).toContainEqual({ memberId: id, role: 'viewer' });
  });
});
