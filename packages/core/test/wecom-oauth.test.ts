import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { domainEvents, members, wecomApps, wecomBindStates } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { decryptConfig } from '../src/notifications/secrets';
import { setMemberWecomUserid } from '../src/wecom/accounts';
import { getWecomApp, saveWecomApp } from '../src/wecom/app';
import { completeWecomBind, startWecomBind, WECOM_API_BASE, type WecomOAuthDeps } from '../src/wecom/oauth';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

const SECRET = 'app-secret-demo-0001';
const KEY = 'wecom-test-secret-wecom-test-secret-0001';

/** 假企业微信接口：只认 corpsecret = SECRET；code-ok → zhangsan，code-dup → lisi，其他 code 报错。不连网络。 */
function fakeWecom() {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const u = new URL(String(input));
    calls.push(`${u.origin}${u.pathname}`);
    if (u.pathname === '/cgi-bin/gettoken') {
      return Response.json(u.searchParams.get('corpsecret') === SECRET ? { errcode: 0, errmsg: 'ok', access_token: 'tok-1', expires_in: 7200 } : { errcode: 40001, errmsg: 'invalid credential' });
    }
    if (u.pathname === '/cgi-bin/auth/getuserinfo') {
      if (u.searchParams.get('access_token') !== 'tok-1') return Response.json({ errcode: 40014, errmsg: 'invalid access_token' });
      const code = u.searchParams.get('code');
      if (code === 'code-ok') return Response.json({ errcode: 0, errmsg: 'ok', userid: 'zhangsan' });
      if (code === 'code-dup') return Response.json({ errcode: 0, errmsg: 'ok', userid: 'lisi' });
      if (code === 'code-outsider') return Response.json({ errcode: 0, errmsg: 'ok', openid: 'o-123' });
      return Response.json({ errcode: 40029, errmsg: 'invalid code' });
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchFn };
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let b: Actor;
const fake = fakeWecom();
/** 假接口的地址只用本机回环与随机端口；请求由注入的 fetch 处理，不会真的连出去。 */
const API = `http://127.0.0.1:${40000 + Math.floor(Math.random() * 20000)}`;
const deps: WecomOAuthDeps = { secretKey: KEY, publicUrl: 'https://flower.example.com', apiBase: API, fetch: fake.fetchFn };
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
});
afterAll(() => t.cleanup());
beforeEach(() => {
  fake.calls.length = 0;
});

describe('企业微信应用', () => {
  it('默认没有；首次保存必须填密钥；只返回脱敏提示与回调地址；密钥加密存储', async () => {
    expect(await getWecomApp(t.db, owner, deps)).toEqual({
      app: null,
      callbackUrl: 'https://flower.example.com/api/v1/orgs/acme/wecom/callback',
      callbackDomain: 'flower.example.com',
    });
    await expect(saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', bindEnabled: true }, deps)).rejects.toThrow('首次保存需要填写应用密钥');
    await expect(saveWecomApp(t.db, owner, { corpId: 'ww-0001', agentId: '1000002', secret: SECRET, bindEnabled: true }, deps)).rejects.toThrow('企业 ID 格式不正确');
    await expect(saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: 'x', secret: SECRET, bindEnabled: true }, deps)).rejects.toThrow('应用 ID（AgentId）应为数字');
    const s = await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', secret: SECRET, bindEnabled: false }, deps);
    expect(s.app).toMatchObject({ corpId: 'ww0001', agentId: '1000002', secretHint: '****0001', bindEnabled: false });
    const [row] = await t.adminDb.select().from(wecomApps);
    expect(row!.secret).toMatch(/^v1:/);
    expect(decryptConfig<{ secret: string }>(row!.secret, KEY).secret).toBe(SECRET);
    const enabled = await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', bindEnabled: true }, deps);
    expect(enabled.app!.bindEnabled).toBe(true);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'wecom_app.updated'));
    for (const r of [s, enabled, events]) expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('只有组织管理员能查看与修改', async () => {
    await expect(getWecomApp(t.db, a, deps)).rejects.toThrow('需要组织管理员权限');
    await expect(saveWecomApp(t.db, a, { corpId: 'ww0001', agentId: '1', secret: SECRET, bindEnabled: true }, deps)).rejects.toThrow('需要组织管理员权限');
  });
});

describe('扫码绑定', () => {
  it('发起：返回企业微信扫码页地址，state 只存摘要；API Token 不能发起', async () => {
    const { url } = await startWecomBind(t.db, a, deps);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://login.work.weixin.qq.com/wwlogin/sso/login');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      login_type: 'CorpApp',
      appid: 'ww0001',
      agentid: '1000002',
      redirect_uri: 'https://flower.example.com/api/v1/orgs/acme/wecom/callback',
    });
    const state = stateOf(url);
    const rows = await t.adminDb.select().from(wecomBindStates);
    expect(JSON.stringify(rows)).not.toContain(state);
    await expect(startWecomBind(t.db, { ...a, tokenId: '00000000-0000-0000-0000-0000000000f1' }, deps)).rejects.toThrow('请在浏览器中登录后绑定企业微信');
  });

  it('回调成功：换取 userid 写入成员，只访问注入的接口地址；默认地址是 qyapi.weixin.qq.com', async () => {
    expect(WECOM_API_BASE).toBe('https://qyapi.weixin.qq.com');
    const state = stateOf((await startWecomBind(t.db, a, deps)).url);
    expect(await completeWecomBind(t.db, a, { code: 'code-ok', state }, deps)).toEqual({ userid: 'zhangsan' });
    expect((await t.adminDb.select().from(members).where(eq(members.id, a.memberId)))[0]!.wecomUserid).toBe('zhangsan');
    expect(fake.calls).toEqual([`${API}/cgi-bin/gettoken`, `${API}/cgi-bin/auth/getuserinfo`]);
    const [ev] = (await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.wecom_changed'))).filter((e) => e.payload.via === 'oauth');
    expect(ev!.payload).toMatchObject({ changes: [{ field: 'wecomUserid', old: null, new: 'zhangsan' }] });
  });

  it('回调的五种失败：重放、过期、不属于当前成员、取消授权、账号已被他人绑定', async () => {
    const replayed = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-bad', state: replayed }, deps)).rejects.toThrow('企业微信返回错误：invalid code（40029）');
    await expect(completeWecomBind(t.db, b, { code: 'code-ok', state: replayed }, deps)).rejects.toThrow('绑定链接无效或已使用');

    const now = new Date();
    const expired = stateOf((await startWecomBind(t.db, b, deps, now)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-dup', state: expired }, deps, new Date(now.getTime() + 11 * 60_000))).rejects.toThrow('绑定链接已过期');

    const others = stateOf((await startWecomBind(t.db, a, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-dup', state: others }, deps)).rejects.toThrow('绑定链接不属于当前登录的成员');

    const cancelled = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: null, state: cancelled }, deps)).rejects.toThrow('没有完成企业微信授权');

    const c = await asMember(t.db, owner, '王五');
    await setMemberWecomUserid(t.db, owner, c.memberId, 'lisi');
    const dup = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-dup', state: dup }, deps)).rejects.toThrow('该企业微信账号已绑定到 王五');
    expect((await t.adminDb.select().from(members).where(eq(members.id, b.memberId)))[0]!.wecomUserid).toBeNull();
  });

  it('非本企业成员；应用密钥错误时报企业微信的错误且不含密钥；未开启时不能发起', async () => {
    const outsider = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-outsider', state: outsider }, deps)).rejects.toThrow('扫码的不是本企业的成员');
    await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', secret: 'wrong-secret-9999', bindEnabled: true }, deps);
    const wrong = stateOf((await startWecomBind(t.db, b, deps)).url);
    const err = await completeWecomBind(t.db, b, { code: 'code-ok', state: wrong }, deps).catch((e: Error) => e);
    expect((err as Error).message).toBe('企业微信返回错误：invalid credential（40001）');
    expect((err as Error).message).not.toContain('wrong-secret');
    await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', bindEnabled: false }, deps);
    await expect(startWecomBind(t.db, b, deps)).rejects.toThrow('组织还没有开启企业微信扫码绑定');
  });
});
