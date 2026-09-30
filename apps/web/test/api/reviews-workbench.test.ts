import { reviewWorkflow } from '@flower/core/testing/factories';
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
  const tags = (await call(app, 'GET', '/orgs/acme/function-tags', { session })).body.tags;
  const designTagId = tags.find((t: { name: string }) => t.name === '设计').id;
  const boss = (await call(app, 'POST', '/orgs/acme/members', { session, body: { displayName: '老板乙' } })).body.member;
  const wf = await call(app, 'POST', '/orgs/acme/workflows', { session, body: { name: '评审流程', body: reviewWorkflow(designTagId, boss.id) } });
  await call(app, 'PUT', `/orgs/acme/products/${productId}/workflow`, { session, body: { versionId: wf.body.version.id } });
});
afterAll(() => cleanup());

describe('评审队列接口', () => {
  it('按流程检查项生成列；统计；按检查项与「等我签字」筛选；参数不合法返回 400', async () => {
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '未开始的需求' } });
    const started = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '评审中的需求' } })).body.requirement;
    await call(app, 'PUT', `/orgs/acme/requirements/${started.id}/checks/feasibility`, { session, body: { state: 'passed' } });

    const q = (await call(app, 'GET', `/orgs/acme/products/${productId}/reviews`, { session })).body.queue;
    expect(q.columns.map((c: { key: string }) => c.key)).toEqual(['feasibility', 'design', 'prd']);
    expect(q.stats).toEqual({ not_started: 1, in_progress: 1, rejected: 0, passed: 0 });
    // session 用户是产品管理员，可以代签「老板乙」这条会签规则（个人签字人可代签，职能标签签字人不行）
    const mine = (await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?mine=1`, { session })).body.queue;
    expect(mine.rows).toMatchObject([{ displayKey: 'PAN-2', waiting: [{ itemKey: 'design', ruleIndex: 1, onBehalf: true }] }]);
    const byItem = (await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?item=feasibility&itemState=passed`, { session })).body.queue;
    expect(byItem.rows.map((r: { displayKey: string }) => r.displayKey)).toEqual(['PAN-2']);
    const bad = await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?state=bogus`, { session });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('筛选条件无效');
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?mine=1`, { token: readToken })).body.queue.rows).toEqual([]);
  });
});

describe('工作台接口', () => {
  it('会话用户得到跨组织汇总；API Token 返回 401', async () => {
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '我负责的需求', ownerMemberId: memberId } });
    const res = await call(app, 'GET', '/me/workbench', { session });
    expect(res.status).toBe(200);
    expect(res.body.workbench.orgs.map((o: { slug: string }) => o.slug)).toEqual(['acme']);
    expect(res.body.workbench.owned.items.map((r: { title: string }) => r.title)).toContain('我负责的需求');
    expect((await call(app, 'GET', '/me/workbench', { token: readToken })).status).toBe(401);
  });
});
