import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

type As = { session?: string; token?: string };

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let pan: string;
let doc: string;
let panReq: { id: string; displayKey: string };
let docReq: { id: string; displayKey: string };
let free: { id: string; displayKey: string };
let agentId: string;
const who: Record<string, As> = {};
const ids: Record<string, string> = {};
const RANDOM = '00000000-0000-4000-8000-000000000001';

/** 邀请一个新账号加入组织，返回其会话与成员 id。 */
async function join(email: string, orgRole: 'member' | 'guest', name: string): Promise<{ session: string; memberId: string }> {
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email, orgRole } });
  const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name, password: 'password123' } });
  const s = sessionFrom(accept.res);
  return { session: s, memberId: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId };
}

const list = (as: As, query = '') => call(app, 'GET', `/orgs/acme/tracking${query}`, as);
const titles = (body: { tracking: { items: Array<{ title: string }> } }) => body.tracking.items.map((i) => i.title).sort();

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  pan = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  doc = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '文档', key: 'DOC' } })).body.product.id;
  panReq = (await call(app, 'POST', `/orgs/acme/products/${pan}/requirements`, { session, body: { title: '网盘需求' } })).body.requirement;
  docReq = (await call(app, 'POST', `/orgs/acme/products/${doc}/requirements`, { session, body: { title: '文档需求' } })).body.requirement;
  for (const r of [panReq, docReq]) await call(app, 'POST', `/orgs/acme/requirements/${r.id}/transitions`, { session, body: { to: 'doing' } });
  free = (await call(app, 'POST', '/orgs/acme/work-items', { session, body: { title: '不关联产品的工作' } })).body.workItem;
  await call(app, 'POST', '/orgs/acme/work-items', { session, body: { title: '网盘工作项', productId: pan } });
  agentId = (await call(app, 'POST', '/orgs/acme/agents', { session, body: { displayName: '机器人' } })).body.member.id;

  const ownerId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  const setRole = (memberId: string, role: 'admin' | 'viewer') => call(app, 'PUT', `/orgs/acme/products/${pan}/roles/${memberId}`, { session, body: { role } });
  const productAdmin = await join('padmin@example.com', 'member', '产品管理员');
  await setRole(productAdmin.memberId, 'admin');
  const editor = await join('editor@example.com', 'member', '编辑成员');
  const viewer = await join('viewer@example.com', 'member', '只读成员');
  await setRole(viewer.memberId, 'viewer');
  const guest = await join('guest@example.com', 'guest', '访客');
  await setRole(guest.memberId, 'viewer');
  const token = async (scope: unknown) => (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: ownerId, name: '跟进', scope } })).body.token as string;
  Object.assign(ids, { owner: ownerId, productAdmin: productAdmin.memberId, editor: editor.memberId, viewer: viewer.memberId, guest: guest.memberId });
  Object.assign(who, {
    owner: { session },
    productAdmin: { session: productAdmin.session },
    editor: { session: editor.session },
    viewer: { session: viewer.session },
    guest: { session: guest.session },
    readToken: { token: await token({ products: 'all', access: 'read' }) },
    panToken: { token: await token({ products: [pan], access: 'write' }) },
  });
});
afterAll(() => cleanup());

describe('跟进列表接口', () => {
  it('各角色都能读取；访客与限定产品的 Token 只看到有角色的产品，响应里没有其他产品与不关联产品的工作项', async () => {
    for (const k of ['owner', 'productAdmin', 'editor', 'viewer', 'guest', 'readToken', 'panToken']) expect((await list(who[k]!)).status, k).toBe(200);
    expect(titles((await list(who.editor!)).body)).toEqual(['不关联产品的工作', '文档需求', '网盘工作项', '网盘需求'].sort());
    for (const k of ['guest', 'panToken']) {
      const r = await list(who[k]!);
      expect(titles(r.body), k).toEqual(['网盘工作项', '网盘需求'].sort());
      const text = JSON.stringify(r.body);
      for (const hidden of ['文档需求', '不关联产品的工作', doc]) expect(text, `${k} ${hidden}`).not.toContain(hidden);
    }
  });

  it('筛选参数格式错误返回 400「筛选参数无效」；合法 UUID 但不存在或看不到时返回空结果', async () => {
    for (const q of ['?product=abc', '?owner=1', '?type=x', '?paused=yes', '?done=true']) {
      const r = await list(who.owner!, q);
      expect(r.status, q).toBe(400);
      expect(r.body.error.message).toBe('筛选参数无效');
    }
    for (const q of [`?product=${RANDOM}`, `?owner=${RANDOM}`, `?type=${RANDOM}`]) {
      const r = await list(who.owner!, q);
      expect(r.status, q).toBe(200);
      expect(r.body.tracking.items, q).toEqual([]);
    }
    const hidden = await list(who.guest!, `?product=${doc}`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.tracking.items).toEqual([]);
    expect(titles((await list(who.owner!, `?product=${pan}&done=1`)).body)).toEqual(['网盘工作项', '网盘需求'].sort());
  });
});

describe('需求的跟进设置与进展记录', () => {
  const path = () => `/orgs/acme/requirements/${panReq.id}`;

  it('产品编辑可以改预计日期、暂停与恢复；只读成员、只读 Token 返回 403；看不到的产品返回 404；需求 id 格式错误返回 400', async () => {
    const date = await call(app, 'PUT', `${path()}/expected-date`, { ...who.editor, body: { expectedDate: '2026-11-30' } });
    expect(date.status).toBe(200);
    expect(date.body.tracking.expectedDate).toBe('2026-11-30');
    const paused = await call(app, 'POST', `${path()}/pause`, { ...who.editor, body: { reason: '等法务' } });
    expect(paused.body.tracking.paused.reason).toBe('等法务');
    const again = await call(app, 'POST', `${path()}/pause`, { ...who.editor, body: { reason: '再暂停' } });
    expect(again.status).toBe(400);
    expect(again.body.error.message).toBe('需求已暂停');
    expect((await call(app, 'POST', `${path()}/resume`, who.editor!)).body.tracking.paused).toBeNull();
    for (const k of ['viewer', 'readToken']) expect((await call(app, 'POST', `${path()}/pause`, { ...who[k], body: { reason: '原因' } })).status, k).toBe(403);
    expect((await call(app, 'PUT', `/orgs/acme/requirements/${docReq.id}/tracking`, { ...who.guest, body: { tracking: false } })).status).toBe(404);
    expect((await call(app, 'PUT', '/orgs/acme/requirements/not-a-uuid/tracking', { ...who.editor, body: { tracking: false } })).status).toBe(400);
    const left = await call(app, 'PUT', `${path()}/tracking`, { ...who.editor, body: { tracking: false } });
    expect(left.body.tracking).toMatchObject({ active: false, optedOut: true });
    expect((await call(app, 'PUT', `${path()}/tracking`, { ...who.editor, body: { tracking: true } })).body.tracking.active).toBe(true);
  });

  it('进展记录：编辑写，作者改，产品管理员删别人的；只读成员不能写；跟进人须为在职真人', async () => {
    const created = await call(app, 'POST', `${path()}/progress`, { ...who.editor, body: { body: '联调中', nextStep: '约测试', followerMemberId: ids.viewer } });
    expect(created.status).toBe(201);
    expect(created.body.progress.follower).toEqual({ id: ids.viewer, displayName: '只读成员' });
    const p = created.body.progress;
    expect((await call(app, 'GET', `${path()}/progress`, who.viewer!)).body.progress.map((x: { body: string }) => x.body)).toEqual(['联调中']);
    expect((await call(app, 'POST', `${path()}/progress`, { ...who.viewer, body: { body: '只读' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `/orgs/acme/progress/${p.id}`, { ...who.productAdmin, body: { body: '改别人的' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `/orgs/acme/progress/${p.id}`, { ...who.editor, body: { body: '联调完成' } })).body.progress.body).toBe('联调完成');
    expect((await call(app, 'DELETE', `/orgs/acme/progress/${p.id}`, who.productAdmin!)).status).toBe(204);
    expect((await call(app, 'POST', `${path()}/progress`, { ...who.editor, body: { body: '空跟进人', followerMemberId: '' } })).status).toBe(400);
    const temp = await call(app, 'POST', `${path()}/progress`, { ...who.editor, body: { body: '临时' } });
    expect((await call(app, 'PATCH', `/orgs/acme/progress/${temp.body.progress.id}`, { ...who.editor, body: { followerMemberId: '' } })).status).toBe(400);
    const agent = await call(app, 'POST', `${path()}/progress`, { ...who.editor, body: { body: '给 Agent', followerMemberId: agentId } });
    expect(agent.status).toBe(400);
    expect(agent.body.error.message).toBe('不能选择 Agent 成员');
  });
});

describe('工作项接口', () => {
  it('不关联产品：非访客成员可以新建与查看；访客、只读 Token、限定产品的 Token 不能新建；修改限负责人、创建人与组织管理员；能看到的成员都能写进展与挂阻塞项', async () => {
    const created = await call(app, 'POST', '/orgs/acme/work-items', { ...who.editor, body: { title: '编辑新建', startedOn: '2026-10-08' } });
    expect(created.status).toBe(201);
    expect(created.body.workItem.displayKey).toMatch(/^W-\d+$/);
    const { id, displayKey } = created.body.workItem;
    for (const k of ['guest', 'readToken', 'panToken']) expect((await call(app, 'POST', '/orgs/acme/work-items', { ...who[k], body: { title: '新建' } })).status, k).toBe(403);
    expect((await call(app, 'GET', `/orgs/acme/work-items/${displayKey}`, who.guest!)).status).toBe(404);
    expect((await call(app, 'GET', `/orgs/acme/work-items/${displayKey}`, who.viewer!)).body.workItem.access).toEqual({ view: true, edit: false, progress: true, manage: false });
    expect((await call(app, 'PATCH', `/orgs/acme/work-items/${id}`, { ...who.viewer, body: { title: '改名' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/progress`, { ...who.viewer, body: { body: '帮忙看了' } })).status).toBe(201);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/blockers`, { ...who.viewer, body: { description: '等对方' } })).status).toBe(201);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/status`, { ...who.editor, body: { status: 'paused' } })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/pause`, { ...who.editor, body: { reason: '等对方排期' } })).body.workItem.paused.reason).toBe('等对方排期');
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/resume`, who.editor!)).body.workItem.paused).toBeNull();
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/status`, { ...who.editor, body: { status: 'done' } })).body.workItem.status).toBe('done');
    expect((await call(app, 'DELETE', `/orgs/acme/work-items/${id}`, who.viewer!)).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/work-items/${id}`, who.editor!)).status).toBe(204);
    expect((await call(app, 'GET', `/orgs/acme/work-items/${displayKey}`, who.editor!)).status).toBe(404);
  });

  it('关联产品的工作项按产品角色：只读成员不能修改；限定产品的 Token 可以在该产品新建', async () => {
    const created = await call(app, 'POST', '/orgs/acme/work-items', { ...who.panToken, body: { title: 'Token 新建', productId: pan } });
    expect(created.status).toBe(201);
    expect((await call(app, 'PATCH', `/orgs/acme/work-items/${created.body.workItem.id}`, { ...who.viewer, body: { title: '改名' } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/work-items', { ...who.panToken, body: { title: '别的产品', productId: doc } })).status).toBe(404);
  });

  it('工作项关注与组织级 @ 候选成员：访客不能关注不关联产品的工作项、不能读取组织级候选成员', async () => {
    expect((await call(app, 'PUT', `/orgs/acme/subscriptions/work_item/${free.id}`, { ...who.editor, body: { following: true } })).body.subscription.following).toBe(true);
    expect((await call(app, 'PUT', `/orgs/acme/subscriptions/work_item/${free.id}`, { ...who.guest, body: { following: true } })).status).toBe(404);
    expect((await call(app, 'GET', `/orgs/acme/subscriptions/task/${free.id}`, who.editor!)).status).toBe(400);
    const members = await call(app, 'GET', '/orgs/acme/mention-members', who.editor!);
    expect(members.status).toBe(200);
    expect(members.body.members.find((m: { id: string }) => m.id === ids.guest).canSeeProduct).toBe(false);
    expect((await call(app, 'GET', '/orgs/acme/mention-members', who.guest!)).status).toBe(403);
  });
});

describe('跟进阈值接口', () => {
  it('组织管理员可以改；成员与只读 Token 返回 403；无效值返回 400；列表随之变化', async () => {
    const body = { warnDays: 10, alertDays: 20, staleUpdateDays: 5 };
    for (const k of ['editor', 'readToken']) expect((await call(app, 'PUT', '/orgs/acme/tracking-settings', { ...who[k], body })).status, k).toBe(403);
    const bad = await call(app, 'PUT', '/orgs/acme/tracking-settings', { session, body: { ...body, warnDays: 20, alertDays: 10 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('标黄天数应小于标红天数');
    expect((await call(app, 'PUT', '/orgs/acme/tracking-settings', { session, body })).body.settings).toEqual(body);
    expect((await call(app, 'GET', '/orgs/acme/tracking-settings', who.editor!)).body.settings).toEqual(body);
    expect((await list(who.guest!)).body.tracking.settings).toEqual(body);
  });
});
