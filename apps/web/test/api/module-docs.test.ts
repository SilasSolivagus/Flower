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
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
});
afterAll(() => cleanup());

const node = async (parentId: string | null, name: string): Promise<string> =>
  (await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { parentId, name } })).body.node.id;

describe('模块文档、影响声明与合入接口', () => {
  it('模块文档：新建（重复调用返回同一份）与列表；只读 Token 能看不能建', async () => {
    const storage = await node(null, '存储');
    const upload = await node(storage, '上传');
    const created = await call(app, 'POST', `/orgs/acme/nodes/${upload}/module-document`, { session });
    expect(created.status).toBe(200);
    expect(created.body.document).toMatchObject({ kind: 'module', title: '上传', status: 'active', node: { id: upload } });
    expect((await call(app, 'POST', `/orgs/acme/nodes/${upload}/module-document`, { session })).body.document.id).toBe(created.body.document.id);
    const tree = await call(app, 'GET', `/orgs/acme/products/${productId}/module-documents`, { token: readToken });
    expect(tree.status).toBe(200);
    expect(tree.body.tree).toMatchObject({ productKey: 'PAN', groups: [{ domain: { name: '存储' }, modules: [{ node: { name: '上传' }, document: { displayKey: created.body.document.displayKey } }] }] });
    expect((await call(app, 'POST', `/orgs/acme/nodes/${storage}/module-document`, { token: readToken })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/nodes/${storage}/module-document`, { session })).status).toBe(400);
  });

  it('影响声明、当场新建节点、合入、修订来源与合入记录', async () => {
    const area = await node(null, '下载域');
    const prd = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '下载 PRD' } })).body.document;
    await call(app, 'PUT', `/orgs/acme/documents/${prd.id}/content`, { session, body: { baseVersion: prd.version, markdown: '## 需求说明\n\n支持离线下载' } });
    const mod = await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes/new-node`, { session, body: { parentId: area, name: '离线' } });
    expect(mod.status).toBe(201);
    expect(mod.body.node).toMatchObject({ depth: 2, name: '离线' });
    const feature = (await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes/new-node`, { session, body: { parentId: mod.body.node.id, name: '离线下载' } })).body.node;

    const added = await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes`, { session, body: { nodeId: feature.id, changeType: 'added', sourceSections: ['需求说明'] } });
    expect(added.status).toBe(201);
    expect(added.body.affected.items).toMatchObject([{ path: '下载域/离线/离线下载', changeType: 'added', sourceSections: [{ key: '需求说明', stale: false }] }]);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes`, { session, body: { nodeId: feature.id, changeType: 'bogus' } })).status).toBe(400);
    const patched = await call(app, 'PATCH', `/orgs/acme/documents/${prd.id}/affected-nodes/${feature.id}`, { session, body: { changeType: 'modified' } });
    expect(patched.body.affected.items[0].changeType).toBe('modified');
    expect((await call(app, 'GET', `/orgs/acme/documents/${prd.id}/affected-nodes`, { token: readToken })).body.affected).toMatchObject({ editable: false, sections: ['需求说明'] });
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes`, { token: readToken, body: { nodeId: feature.id, changeType: 'added' } })).status).toBe(403);

    for (const to of ['review', 'approved', 'launched']) await call(app, 'POST', `/orgs/acme/documents/${prd.id}/transitions`, { session, body: { to } });
    const plan = await call(app, 'GET', `/orgs/acme/documents/${prd.id}/merge`, { token: readToken });
    expect(plan.body.plan).toMatchObject({
      canMerge: false,
      total: 1,
      done: 0,
      groups: [{ module: { name: '离线', path: '下载域/离线' }, document: null, items: [{ name: '离线下载', current: null, prefill: '支持离线下载' }] }],
    });
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/apply`, { token: readToken, body: { baseVersion: null, body: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/apply`, { session, body: { baseVersion: 'x', body: 'x' } })).status).toBe(400);
    const applied = await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/apply`, { session, body: { baseVersion: null, body: '支持离线下载' } });
    expect(applied.body.result).toMatchObject({ status: 'merged', done: 1, total: 1, moduleDocument: { version: 2 } });
    const moduleId = applied.body.result.moduleDocument.id;
    expect((await call(app, 'GET', `/orgs/acme/documents/${moduleId}/revisions`, { session })).body.revisions[0].mergedFrom).toMatchObject({ id: prd.id, displayKey: prd.displayKey });
    expect((await call(app, 'GET', `/orgs/acme/documents/${moduleId}/merge-records`, { token: readToken })).body.records).toMatchObject([
      { changeType: 'modified', feature: { name: '离线下载' }, changeDocument: { displayKey: prd.displayKey } },
    ]);
    expect((await call(app, 'DELETE', `/orgs/acme/documents/${prd.id}/affected-nodes/${feature.id}`, { session })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/skip`, { session })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/reopen`, { session })).status).toBe(400);
  });

  it('畸形 id 返回 400，不是 500', async () => {
    expect((await call(app, 'GET', '/orgs/acme/documents/not-a-uuid/merge', { session })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/nodes/not-a-uuid/module-document', { session })).status).toBe(400);
  });
});
