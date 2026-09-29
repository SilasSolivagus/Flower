import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let readToken: string;

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

describe('阻塞项与关联接口', () => {
  it('新建与解除阻塞项；新建、重复、删除关联', async () => {
    const a = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '上传断点续传' } })).body.requirement;
    const b = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '下载断点续传' } })).body.requirement;

    const blocker = await call(app, 'POST', `/orgs/acme/requirements/${a.id}/blockers`, { session, body: { description: '等待存储接口' } });
    expect(blocker.status).toBe(201);
    expect(blocker.body.blocker).toMatchObject({ description: '等待存储接口', status: 'active' });
    expect((await call(app, 'POST', `/orgs/acme/requirements/${a.id}/blockers`, { token: readToken, body: { description: 'x' } })).status).toBe(403);
    const resolved = await call(app, 'POST', `/orgs/acme/blockers/${blocker.body.blocker.id}/resolve`, { session });
    expect(resolved.body.blocker.status).toBe('resolved');

    const rel = await call(app, 'POST', `/orgs/acme/requirements/${a.id}/relations`, { session, body: { toId: b.id, type: 'blocks' } });
    expect(rel.status).toBe(201);
    const dup = await call(app, 'POST', `/orgs/acme/requirements/${a.id}/relations`, { session, body: { toId: b.id, type: 'blocks' } });
    expect(dup.status).toBe(409);
    expect((await call(app, 'POST', `/orgs/acme/requirements/${a.id}/relations`, { session, body: { toId: b.id, type: 'copy_of' } })).status).toBe(400);
    const detail = await call(app, 'GET', `/orgs/acme/requirements/${b.displayKey}`, { session });
    expect(detail.body.requirement.relations).toMatchObject([{ id: rel.body.relation.id, type: 'blocks', direction: 'in' }]);
    expect((await call(app, 'DELETE', `/orgs/acme/relations/${rel.body.relation.id}`, { session })).status).toBe(204);
  });
});

describe('结构树与产品成员角色接口', () => {
  it('新建、改名、移动、排序节点；读取产品成员角色', async () => {
    const root = await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { name: '会员与支付' } });
    expect(root.status).toBe(201);
    const second = (await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { name: '存储' } })).body.node;
    const child = (await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { parentId: root.body.node.id, name: '续费' } })).body.node;
    expect(child.depth).toBe(2);
    const renamed = await call(app, 'PATCH', `/orgs/acme/nodes/${child.id}`, { session, body: { name: '续费管理', status: 'deprecated' } });
    expect(renamed.body.node).toMatchObject({ name: '续费管理', status: 'deprecated' });
    const moved = await call(app, 'POST', `/orgs/acme/nodes/${child.id}/move`, { session, body: { parentId: second.id } });
    expect(moved.body.node).toMatchObject({ parentId: second.id, depth: 2 });
    const ordered = await call(app, 'PUT', `/orgs/acme/products/${productId}/nodes/order`, { session, body: { parentId: null, nodeIds: [second.id, root.body.node.id] } });
    expect(ordered.body.nodes.map((n: { name: string }) => n.name)).toEqual(['存储', '会员与支付']);
    expect((await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { token: readToken, body: { name: '越权' } })).status).toBe(403);
    const nodes = await call(app, 'GET', `/orgs/acme/products/${productId}/nodes`, { session });
    expect(nodes.body.nodes.find((n: { name: string }) => n.name === '续费管理')).toMatchObject({ description: null, status: 'deprecated' });

    const members = await call(app, 'GET', `/orgs/acme/products/${productId}/members`, { session });
    expect(members.body.members).toMatchObject([{ displayName: 'Owner', orgRole: 'owner', role: null }]);
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/members`, { token: readToken })).status).toBe(403);
  });
});
