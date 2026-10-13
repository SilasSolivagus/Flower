import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

type As = { session?: string; token?: string };

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let pan: string;
let doc: string;
const who: Record<string, As> = {};

/** 邀请一个新账号加入组织，返回其会话与成员 id。 */
async function join(email: string, orgRole: 'member' | 'guest', name: string): Promise<{ session: string; memberId: string }> {
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email, orgRole } });
  const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name, password: 'password123' } });
  const s = sessionFrom(accept.res);
  return { session: s, memberId: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId };
}

const dash = (productId: string, as: As, query = '') => call(app, 'GET', `/orgs/acme/products/${productId}/dashboard${query}`, as);
const summary = (as: As, query = '') => call(app, 'GET', `/orgs/acme/dashboard${query}`, as);

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  pan = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  doc = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '文档', key: 'DOC' } })).body.product.id;
  const panReq = (await call(app, 'POST', `/orgs/acme/products/${pan}/requirements`, { session, body: { title: '网盘需求' } })).body.requirement;
  const docReq = (await call(app, 'POST', `/orgs/acme/products/${doc}/requirements`, { session, body: { title: '文档需求' } })).body.requirement;
  const special = (await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'special', name: '专项甲', startDate: '2020-01-01', endDate: '2099-12-31' } })).body
    .iteration.id;
  await call(app, 'PUT', `/orgs/acme/requirements/${panReq.id}/iteration`, { session, body: { iterationId: special } });
  await call(app, 'PUT', `/orgs/acme/requirements/${docReq.id}/iteration`, { session, body: { iterationId: special } });

  const ownerId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  const setRole = (memberId: string, role: 'admin' | 'viewer') => call(app, 'PUT', `/orgs/acme/products/${pan}/roles/${memberId}`, { session, body: { role } });
  const productAdmin = await join('padmin@example.com', 'member', '产品管理员');
  await setRole(productAdmin.memberId, 'admin');
  const editor = await join('editor@example.com', 'member', '编辑成员');
  const viewer = await join('viewer@example.com', 'member', '只读成员');
  await setRole(viewer.memberId, 'viewer');
  const guest = await join('guest@example.com', 'guest', '访客');
  await setRole(guest.memberId, 'viewer');
  const token = async (scope: unknown) => (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: ownerId, name: '看板', scope } })).body.token as string;
  Object.assign(who, {
    owner: { session },
    productAdmin: { session: productAdmin.session },
    editor: { session: editor.session },
    viewer: { session: viewer.session },
    guest: { session: guest.session },
    readToken: { token: await token({ products: 'all', access: 'read' }) },
    panToken: { token: await token({ products: [pan], access: 'read' }) },
  });
});
afterAll(() => cleanup());

describe('产品看板接口', () => {
  it('能看到该产品的成员都可以查看（组织管理员、产品管理员、编辑、只读、访客、只读 Token）', async () => {
    for (const k of ['owner', 'productAdmin', 'editor', 'viewer', 'guest', 'readToken', 'panToken']) {
      const r = await dash(pan, who[k]!);
      expect(r.status, k).toBe(200);
      expect(r.body.dashboard.product.key, k).toBe('PAN');
    }
  });

  it('看不到的产品返回 404；其他人能看到另一个产品', async () => {
    for (const k of ['owner', 'productAdmin', 'editor', 'viewer', 'readToken']) expect((await dash(doc, who[k]!)).status, k).toBe(200);
    for (const k of ['guest', 'panToken']) {
      const r = await dash(doc, who[k]!);
      expect(r.status, k).toBe(404);
      expect(r.body.error.message).toBe('产品不存在');
      const text = JSON.stringify(r.body);
      for (const hidden of ['文档', '文档需求', doc]) expect(text, `${k} ${hidden}`).not.toContain(hidden);
    }
  });

  it('看不到的产品的数据不出现在响应里：专项只统计本产品的需求', async () => {
    const body = (await dash(pan, who.guest!)).body;
    expect(body.dashboard.specials).toEqual([expect.objectContaining({ name: '专项甲', total: 1 })]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('文档需求');
    expect(text).not.toContain(doc);
  });

  it('时间段参数：默认近 90 天、近 30 天、自定义；不合法时 400 / 404 与中文原因', async () => {
    expect((await dash(pan, who.owner!)).body.dashboard.window.days).toBe(90);
    expect((await dash(pan, who.owner!, '?range=30')).body.dashboard.window.days).toBe(30);
    expect((await dash(pan, who.owner!, '?from=2026-01-01&to=2026-01-31')).body.dashboard.window).toMatchObject({ from: '2026-01-01', to: '2026-01-31', days: 31 });
    const bad = async (query: string, status: number, message: string) => {
      const r = await dash(pan, who.owner!, query);
      expect(r.status, query).toBe(status);
      expect(r.body.error.message, query).toBe(message);
    };
    await bad('?range=7', 400, '时间段参数无效');
    await bad('?iteration=abc', 400, '时间段参数无效');
    await bad('?from=2026-01-01', 400, '自定义时间段需要开始和结束日期');
    await bad('?from=2026-02-01&to=2026-01-01', 400, '结束日期不能早于开始日期');
    await bad('?iteration=0190a0b0-0000-7000-8000-000000000001', 404, '迭代不存在');
    const badId = await call(app, 'GET', '/orgs/acme/products/abc/dashboard', who.owner!);
    expect(badId.status).toBe(400);
    expect(badId.body.error.message).toBe('产品无效');
  });
});

describe('组织汇总接口', () => {
  it('组织管理员与全部产品范围的只读 Token 可以查看，每个产品一行', async () => {
    for (const k of ['owner', 'readToken']) {
      const r = await summary(who[k]!);
      expect(r.status, k).toBe(200);
      expect(r.body.dashboard.products.map((p: { key: string }) => p.key), k).toEqual(['DOC', 'PAN']);
    }
  });

  it('产品管理员、编辑、只读、访客、限定产品的 Token 返回 403，响应里没有任何产品数据', async () => {
    for (const k of ['productAdmin', 'editor', 'viewer', 'guest', 'panToken']) {
      const r = await summary(who[k]!);
      expect(r.status, k).toBe(403);
      expect(r.body.error.message).toBe('需要组织管理员权限');
      const text = JSON.stringify(r.body);
      for (const hidden of ['PAN', '网盘', pan, 'DOC', '文档', doc]) expect(text, `${k} ${hidden}`).not.toContain(hidden);
    }
  });

  it('不支持按迭代查看', async () => {
    const r = await summary(who.owner!, '?iteration=0190a0b0-0000-7000-8000-000000000001');
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('组织汇总不支持按迭代查看');
  });
});
