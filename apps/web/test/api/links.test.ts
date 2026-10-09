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

describe('链接接口', () => {
  it('需求描述的链接卡随详情返回；「被引用」；补全搜索', async () => {
    const target = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '登录改版' } })).body.requirement;
    const src = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '引用方', description: '依赖 [[PAN-1]]。' } })).body.requirement;
    const detail = await call(app, 'GET', `/orgs/acme/requirements/${src.displayKey}`, { session });
    expect(detail.body.requirement.links).toMatchObject([{ text: 'PAN-1', state: 'ok', title: '登录改版', href: 'requirements/PAN-1' }]);

    const back = await call(app, 'GET', `/orgs/acme/backlinks?type=requirement&id=${target.id}`, { session });
    expect(back.status).toBe(200);
    expect(back.body.groups).toMatchObject([{ kind: 'requirement', displayKey: 'PAN-2', items: [{ via: 'description', context: '依赖 [[PAN-1]]。' }] }]);
    expect((await call(app, 'GET', '/orgs/acme/backlinks?type=bogus&id=x', { session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/backlinks?type=requirement&id=00000000-0000-7000-8000-000000000000', { session })).status).toBe(404);

    const search = await call(app, 'GET', `/orgs/acme/links/search?product=${productId}&q=${encodeURIComponent('登录')}`, { session });
    expect(search.body.suggestions[0]).toMatchObject({ kind: 'requirement', insert: 'PAN-1', next: 'insert' });
    expect((await call(app, 'GET', '/orgs/acme/links/search?q=x', { session })).status).toBe(400);
    expect((await call(app, 'GET', `/orgs/acme/links/search?product=${productId}&q=PAN`, { token: readToken })).status).toBe(200);
  });

  it('PRD 正文与评论的链接卡；按编号读取任务（只读 Token 可读）', async () => {
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '登录 PRD' } })).body.document;
    await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session, body: { baseVersion: doc.version, markdown: '## 背景\n\n见 [[PAN-1]]' } });
    const cards = await call(app, 'GET', `/orgs/acme/documents/${doc.id}/links`, { session });
    expect(cards.body.cards).toMatchObject([{ text: 'PAN-1', state: 'ok' }]);
    const comment = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/comments`, { session, body: { body: '对应 [[PAN-PRD-1#背景]]' } });
    expect(comment.body.comment.links).toMatchObject([{ text: 'PAN-PRD-1#背景', state: 'ok', href: 'documents/PAN-PRD-1?section=%E8%83%8C%E6%99%AF' }]);

    const iteration = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0105', startDate: '2026-01-05', endDate: '2026-01-16' } })
    ).body.iteration;
    await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId: iteration.id, title: '联调' } });
    const task = await call(app, 'GET', '/orgs/acme/tasks/pan-t-1', { token: readToken });
    expect(task.status).toBe(200);
    expect(task.body.task).toMatchObject({ displayKey: 'PAN-T-1', title: '联调', iteration: { name: '迭代0105' } });
    expect((await call(app, 'GET', '/orgs/acme/tasks/PAN-T-9', { session })).status).toBe(404);
  });

  it('畸形 id 返回 400，不是 500', async () => {
    expect((await call(app, 'GET', '/orgs/acme/backlinks?type=requirement&id=not-a-uuid', { session })).status).toBe(400);
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '畸形 id 用例' } })).body.document;
    expect((await call(app, 'GET', '/orgs/acme/documents/not-a-uuid/links', { session })).status).toBe(400);
    // 合法但不存在的 id 走核心的「不存在」判断，不受这里的格式校验影响
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/links`, { session })).status).toBe(200);
  });
});
