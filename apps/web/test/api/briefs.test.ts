import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

type As = { session?: string; token?: string };

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let pan: string;
let doc: string;
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

/** 不按 JSON 解析的请求（Markdown 上下文）。 */
const raw = (path: string, as: As) =>
  app.request(`/api/v1${path}`, {
    headers: { ...(as.token ? { authorization: `Bearer ${as.token}` } : {}), ...(as.session ? { cookie: `flower_session=${as.session}` } : {}) },
  });
const create = (as: As, productId: string, body: Record<string, unknown>) => call(app, 'POST', `/orgs/acme/products/${productId}/briefs`, { ...as, body });
const keys = async (as: As, q = ''): Promise<string[]> => {
  const r = await call(app, 'GET', `/orgs/acme/briefs${q}`, as);
  expect(r.status, q).toBe(200);
  return r.body.briefs.map((b: { displayKey: string }) => b.displayKey);
};

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  pan = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  doc = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '文档', key: 'DOC' } })).body.product.id;
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
  const token = async (scope: unknown) => (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: ownerId, name: '简报', scope } })).body.token as string;
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

describe('新建与列表', () => {
  it('编辑新建 201 并返回简报详情；只读成员与只读 Token 403；访客对没有角色的产品 404；产品 id 格式错误 400', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${pan}/requirements`, { session, body: { title: '网盘需求' } })).body.requirement;
    const r = await create(who.editor!, pan, { title: '上传提速', requirementIds: [req.id] });
    expect(r.status).toBe(201);
    expect(r.body.document).toMatchObject({ displayKey: 'PAN-B-1', kind: 'brief', status: 'discussing', requirements: [{ displayKey: 'PAN-1' }], brief: { version: 'v0.1' } });
    ids.brief = r.body.document.id;
    for (const k of ['viewer', 'readToken']) expect((await create(who[k]!, pan, { title: '不行' })).status, k).toBe(403);
    expect((await create(who.guest!, doc, { title: '不行' })).status).toBe(404);
    expect((await create(who.editor!, 'not-a-uuid', { title: '不行' })).status).toBe(400);
    ids.docBrief = (await create(who.owner!, doc, { title: '文档产品的简报' })).body.document.id;
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-B-1', who.viewer!)).body.document.kind).toBe('brief');
  });

  it('列表：只看到有角色的产品；按产品、状态、决策人筛选；格式错误 400；合法 UUID 但看不到或不存在时返回空', async () => {
    expect(await keys(who.owner!)).toEqual(['DOC-B-1', 'PAN-B-1']);
    for (const k of ['guest', 'panToken']) expect(await keys(who[k]!), k).toEqual(['PAN-B-1']);
    expect(await keys(who.owner!, `?product=${pan}`)).toEqual(['PAN-B-1']);
    expect(await keys(who.owner!, '?status=ready,discarded')).toEqual([]);
    expect(await keys(who.guest!, `?product=${doc}`)).toEqual([]);
    expect(await keys(who.owner!, `?decider=${RANDOM}`)).toEqual([]);
    for (const q of ['?product=abc', '?status=draft', '?decider=1']) {
      const r = await call(app, 'GET', `/orgs/acme/briefs${q}`, who.owner!);
      expect([r.status, r.body.error.message], q).toEqual([400, '筛选参数无效']);
    }
    expect((await call(app, 'GET', '/orgs/acme/briefs', who.guest!)).body.briefs[0]).toMatchObject({ requirementCount: 1, gate: { passed: 2, total: 11 }, decider: null });
  });
});

describe('头部、闸口、状态与覆盖需求', () => {
  it('头部：编辑可改；只读成员与只读 Token 403；决策人不能是 Agent；id 格式错误 400；限定产品的 Token 改不了其他产品的简报', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}`;
    const r = await call(app, 'PATCH', path, {
      ...who.editor,
      body: { version: 'v0.2', deciderMemberId: ids.viewer, relatedLinks: [{ kind: 'url', url: 'https://doc.example.com/a', note: '群聊' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.document.brief).toMatchObject({
      version: 'v0.2',
      decider: { id: ids.viewer, displayName: '只读成员' },
      relatedLinks: [{ kind: 'url', url: 'https://doc.example.com/a', note: '群聊' }],
    });
    for (const k of ['viewer', 'readToken']) expect((await call(app, 'PATCH', path, { ...who[k], body: { version: 'v9' } })).status, k).toBe(403);
    const agent = await call(app, 'PATCH', path, { ...who.editor, body: { deciderMemberId: agentId } });
    expect([agent.status, agent.body.error.message]).toEqual([400, '不能选择 Agent 成员']);
    expect((await call(app, 'PATCH', '/orgs/acme/briefs/not-a-uuid', { ...who.editor, body: { version: 'v1' } })).status).toBe(400);
    expect((await call(app, 'PATCH', `/orgs/acme/briefs/${ids.docBrief}`, { ...who.panToken, body: { version: 'v1' } })).status).toBe(404);
  });

  it('闸口：只读成员、访客与只读 Token 可读；编辑勾选人工项；自动项、非数字的项号与只读 Token 勾选被拒', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}/gate`;
    for (const k of ['viewer', 'readToken', 'guest']) expect((await call(app, 'GET', path, who[k]!)).body.gate.total, k).toBe(11);
    const checked = await call(app, 'PUT', `${path}/2`, { ...who.editor, body: { checked: true } });
    expect([checked.status, checked.body.gate.passed]).toEqual([200, 3]);
    expect((await call(app, 'PUT', `${path}/1`, { ...who.editor, body: { checked: true } })).status).toBe(400);
    expect((await call(app, 'PUT', `${path}/x`, { ...who.editor, body: { checked: true } })).status).toBe(400);
    expect((await call(app, 'PUT', `${path}/3`, { ...who.readToken, body: { checked: true } })).status).toBe(403);
  });

  it('状态与覆盖需求沿用文档接口：可改为可写 PRD、不能改为 PRD 的状态；关联别的产品的需求 400', async () => {
    const t1 = await call(app, 'POST', `/orgs/acme/documents/${ids.brief}/transitions`, { ...who.editor, body: { to: 'ready' } });
    expect([t1.status, t1.body.document.status]).toEqual([200, 'ready']);
    expect((await call(app, 'POST', `/orgs/acme/documents/${ids.brief}/transitions`, { ...who.editor, body: { to: 'draft' } })).status).toBe(400);
    const docReq = (await call(app, 'POST', `/orgs/acme/products/${doc}/requirements`, { session, body: { title: '文档需求' } })).body.requirement;
    const bad = await call(app, 'POST', `/orgs/acme/documents/${ids.brief}/requirements`, { ...who.editor, body: { requirementIds: [docReq.id] } });
    expect([bad.status, bad.body.error.message]).toEqual([400, 'DOC-1 不属于这份简报所在的产品']);
  });
});

describe('上下文', () => {
  it('Markdown（缺省）与 JSON；只读 Token 可读；看不到的简报 404；格式与 id 错误 400', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}/context`;
    const res = await raw(path, who.readToken!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text.startsWith('# PAN-B-1 上传提速\n')).toBe(true);
    expect(text).toContain('| 确认人 | 只读成员 |');
    expect(text).toContain('## 写 PRD 前检查（3/11，还差 8 项）');
    expect(text).toContain('| PAN-1 | 网盘需求 |');
    const json = await call(app, 'GET', `${path}?format=json`, who.viewer!);
    expect(json.body.context.brief).toMatchObject({ displayKey: 'PAN-B-1', statusLabel: '可以写 PRD', version: 'v0.2' });
    expect(json.body.context.requirements).toHaveLength(1);
    for (const k of ['panToken', 'guest']) expect((await call(app, 'GET', `/orgs/acme/briefs/${ids.docBrief}/context?format=json`, who[k]!)).status, k).toBe(404);
    for (const k of ['panToken', 'guest']) expect((await call(app, 'GET', '/orgs/acme/documents/DOC-B-1', who[k]!)).status, k).toBe(404);
    const html = await call(app, 'GET', `${path}?format=html`, who.viewer!);
    expect([html.status, html.body.error.message]).toEqual([400, '格式只能是 markdown 或 json']);
    expect((await call(app, 'GET', '/orgs/acme/briefs/not-a-uuid/context?format=json', who.viewer!)).status).toBe(400);
  });
});

describe('转 PRD', () => {
  it('编辑 201 返回 PRD 与跳过的需求；已转过再转 409 并给出已有 PRD；确认后再生成；只读 Token 403', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}/convert`;
    expect((await call(app, 'POST', path, { ...who.readToken, body: {} })).status).toBe(403);
    const first = await call(app, 'POST', path, { ...who.editor, body: {} });
    expect(first.status).toBe(201);
    expect(first.body.document).toMatchObject({ displayKey: 'PAN-PRD-1', kind: 'change', sourceBrief: { displayKey: 'PAN-B-1' }, requirements: [{ displayKey: 'PAN-1' }] });
    expect(first.body.skipped).toEqual([]);
    const again = await call(app, 'POST', path, { ...who.editor, body: {} });
    expect([again.status, again.body.error.message, again.body.error.details]).toEqual([409, '这份简报已生成 PAN-PRD-1', { documentKey: 'PAN-PRD-1' }]);
    const second = await call(app, 'POST', path, { ...who.editor, body: { again: true } });
    expect([second.status, second.body.document.displayKey]).toEqual([201, 'PAN-PRD-2']);
    expect(second.body.skipped).toEqual([expect.objectContaining({ displayKey: 'PAN-1', documentKey: 'PAN-PRD-1' })]);
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-B-1', who.viewer!)).body.document.brief.convertedDocument.displayKey).toBe('PAN-PRD-2');
  });
});

describe('模板按类型', () => {
  it('按类型列出；组织管理员新建简报模板，产品管理员覆盖，编辑 403；类型参数错误 400', async () => {
    const list = await call(app, 'GET', '/orgs/acme/templates?kind=brief', who.owner!);
    expect(list.body.templates.map((x: { name: string; kind: string }) => [x.kind, x.name])).toEqual([['brief', '需求简报（预置）']]);
    expect((await call(app, 'GET', '/orgs/acme/templates', who.owner!)).body.templates.map((x: { kind: string }) => x.kind)).toEqual(['change']);
    const created = await call(app, 'POST', '/orgs/acme/templates', { ...who.owner, body: { kind: 'brief', name: '轻量简报', body: '## 1. 问题与目标\n', sections: [], guidance: '先写结论' } });
    expect([created.status, created.body.template.kind, created.body.template.guidance]).toEqual([201, 'brief', '先写结论']);
    const override = await call(app, 'POST', '/orgs/acme/templates', { ...who.productAdmin, body: { productId: pan, kind: 'brief', name: '轻量简报', body: '## 产品版\n', sections: [] } });
    expect(override.status).toBe(201);
    expect((await call(app, 'POST', '/orgs/acme/templates', { ...who.editor, body: { productId: pan, kind: 'brief', name: '编辑的', body: '', sections: [] } })).status).toBe(403);
    expect((await call(app, 'GET', `/orgs/acme/templates?product=${pan}&usable=1&kind=brief`, who.editor!)).body.templates.map((x: { productId: string | null }) => x.productId)).toEqual([null, pan]);
    expect((await call(app, 'POST', '/orgs/acme/templates/preset?kind=brief', { ...who.owner, body: {} })).status).toBe(409);
    expect((await call(app, 'GET', '/orgs/acme/templates?kind=module', who.owner!)).status).toBe(400);
    const badGet = await call(app, 'GET', '/orgs/acme/templates?kind=module', who.owner!);
    expect(badGet.body.error.message).toBe('模板类型无效');
    expect((await call(app, 'POST', '/orgs/acme/templates/preset?kind=module', { ...who.owner, body: {} })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/templates', { ...who.owner, body: { kind: 'module', name: 'x', body: '', sections: [] } })).status).toBe(400);
  });
});
