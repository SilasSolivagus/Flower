import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, initAndLogin, makeApp } from './helpers';

let app: Awaited<ReturnType<typeof makeApp>>['app'];
let cleanup: () => Promise<void>;
let session: string;
let productId: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  const product = await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } });
  productId = product.body.product.id as string;
});
afterAll(() => cleanup());

const get = (path: string) => call(app, 'GET', path, { session });
const post = (path: string, body: unknown) => call(app, 'POST', path, { session, body });

describe('批次 2 接口', () => {
  it('工作项列表空 200，默认不含已完成和已取消，canceled=1 能查到', async () => {
    const empty = await get('/orgs/acme/work-items');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });
    const active = await post('/orgs/acme/work-items', { title: '进行中的支持', productId });
    const done = await post('/orgs/acme/work-items', { title: '已完成的支持', productId });
    const canceled = await post('/orgs/acme/work-items', { title: '已取消的支持', productId });
    expect(active.status).toBe(201);
    await post(`/orgs/acme/work-items/${done.body.workItem.id}/status`, { status: 'done' });
    await post(`/orgs/acme/work-items/${canceled.body.workItem.id}/status`, { status: 'canceled' });
    const def = await get('/orgs/acme/work-items');
    expect(def.body.items.map((i: { title: string }) => i.title)).toEqual(['进行中的支持']);
    expect(def.body.items[0]).toMatchObject({ displayKey: 'W-1', stage: { key: 'active', label: '进行中' }, canWrite: true });
    const both = await get('/orgs/acme/work-items?done=1&canceled=1');
    expect(both.body.items.map((i: { title: string }) => i.title).sort()).toEqual(['已取消的支持', '已完成的支持', '进行中的支持']);
    const tooMany = await get('/orgs/acme/work-items?limit=501');
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.message).toBe('一次最多查询 500 条');
  });

  it('批量全成功、部分失败、超限 400、需求 id 进失败', async () => {
    const wi = await post('/orgs/acme/work-items', { title: '批量甲', productId });
    const req = await post(`/orgs/acme/products/${productId}/requirements`, { title: '不是工作项' });
    const ok = await post('/orgs/acme/work-items/batch-status', { ids: [wi.body.workItem.id], status: 'done' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ updated: 1, failed: [] });
    const partial = await post('/orgs/acme/work-items/batch-status', { ids: [wi.body.workItem.id, req.body.requirement.id], status: 'canceled' });
    expect(partial.body.updated).toBe(1);
    expect(partial.body.failed).toEqual([{ id: req.body.requirement.id, reason: '无权或不存在' }]);
    const ids = Array.from({ length: 51 }, () => '00000000-0000-4000-8000-000000000001');
    const capped = await post('/orgs/acme/work-items/batch-status', { ids, status: 'active' });
    expect(capped.status).toBe(400);
    expect(capped.body.error.message).toBe('一次最多修改 50 条');
  });

  it('需求标签可建可挂，详情带 tags，重名 400', async () => {
    const created = await post('/orgs/acme/requirement-tags', { name: '体验' });
    expect(created.status).toBe(201);
    expect(created.body.tag).toMatchObject({ name: '体验', color: '#64748b', usageCount: 0 });
    const dup = await post('/orgs/acme/requirement-tags', { name: '体验' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toBe('已存在同名需求标签');
    const req = await post(`/orgs/acme/products/${productId}/requirements`, { title: '带标签' });
    const put = await call(app, 'PUT', `/orgs/acme/requirements/${req.body.requirement.id}/tags`, { session, body: { tagIds: [created.body.tag.id] } });
    expect(put.status).toBe(200);
    expect(put.body.tags).toMatchObject([{ id: created.body.tag.id, name: '体验' }]);
    const detail = await get(`/orgs/acme/requirements/${req.body.requirement.displayKey}`);
    expect(detail.body.requirement.tags).toMatchObject([{ name: '体验' }]);
    const missing = await call(app, 'PUT', `/orgs/acme/requirements/${req.body.requirement.id}/tags`, {
      session,
      body: { tagIds: ['00000000-0000-4000-8000-000000000099'] },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe('标签不存在');
  });
});
