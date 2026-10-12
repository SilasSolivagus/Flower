import { and, eq, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from '../crypto';
import type { Db } from '../db/client';
import { organizations, wecomApps, wecomBindStates } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { WECOM_USERID_RE } from '../notifications/constants';
import { decryptConfig } from '../notifications/secrets';
import { writeWecomUseridTx } from './accounts';
import { wecomCallbackUrl } from './app';

/** 服务端只访问这个地址；测试经 deps.apiBase 换成本机假服务。 */
export const WECOM_API_BASE = 'https://qyapi.weixin.qq.com';
/** 企业微信扫码登录页：只由浏览器跳转打开，服务端不访问。 */
export const WECOM_LOGIN_URL = 'https://login.work.weixin.qq.com/wwlogin/sso/login';
export const WECOM_STATE_TTL_MS = 10 * 60 * 1000;

export type WecomOAuthDeps = { secretKey: string; publicUrl: string; apiBase: string; fetch?: typeof fetch };
type WecomReply = { errcode?: number; errmsg?: string };

const NOT_IN_BROWSER = '请在浏览器中登录后绑定企业微信';

/** 调用企业微信接口。错误信息里不出现请求网址（gettoken 的网址里含应用密钥）。 */
async function wecomGet<T extends WecomReply>(deps: WecomOAuthDeps, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, deps.apiBase);
  url.search = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError('precondition_failed', '无法连接企业微信，请稍后重试');
  }
  if (!res.ok) throw new AppError('precondition_failed', `企业微信接口返回 HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new AppError('precondition_failed', '企业微信接口返回的内容无法解析');
  }
}

const wecomError = (r: WecomReply): AppError => new AppError('precondition_failed', `企业微信返回错误：${r.errmsg ?? '未知错误'}（${r.errcode ?? '无错误码'}）`);

/** 发起扫码绑定：生成一次性 state（只存摘要，10 分钟过期），返回企业微信扫码页地址。 */
export async function startWecomBind(db: Db, actor: Actor, deps: WecomOAuthDeps, now: Date = new Date()): Promise<{ url: string }> {
  if (actor.tokenId) throw new AppError('forbidden', NOT_IN_BROWSER);
  return withOrg(db, actor.orgId, async (tx) => {
    const [app] = await tx.select().from(wecomApps).where(eq(wecomApps.orgId, actor.orgId));
    if (!app?.bindEnabled) throw new AppError('invalid', '组织还没有开启企业微信扫码绑定，请联系组织管理员');
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, actor.orgId));
    const state = randomToken(24);
    await tx.insert(wecomBindStates).values({ orgId: actor.orgId, memberId: actor.memberId, stateHash: sha256(state), expiresAt: new Date(now.getTime() + WECOM_STATE_TTL_MS) });
    const url = new URL(WECOM_LOGIN_URL);
    url.search = new URLSearchParams({ login_type: 'CorpApp', appid: app.corpId, agentid: app.agentId, redirect_uri: wecomCallbackUrl(deps.publicUrl, org!.slug), state }).toString();
    return { url: url.toString() };
  });
}

/**
 * 扫码回调：先在独立事务里把 state 标为已用（之后无论换取成功与否都不能再用），再校验所属成员、有效期与授权码，
 * 用应用密钥换 access_token、用授权码换 userid，最后写入当前成员。
 */
export async function completeWecomBind(db: Db, actor: Actor, input: { code: string | null; state: string | null }, deps: WecomOAuthDeps, now: Date = new Date()): Promise<{ userid: string }> {
  if (actor.tokenId) throw new AppError('forbidden', NOT_IN_BROWSER);
  if (!input.state) throw new AppError('invalid', '绑定链接无效或已使用，请重新扫码');
  const st = await withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .update(wecomBindStates)
      .set({ usedAt: now })
      .where(and(eq(wecomBindStates.stateHash, sha256(input.state!)), isNull(wecomBindStates.usedAt)))
      .returning();
    return row ?? null;
  });
  if (!st) throw new AppError('invalid', '绑定链接无效或已使用，请重新扫码');
  if (st.memberId !== actor.memberId) throw new AppError('invalid', '绑定链接不属于当前登录的成员，请重新扫码');
  if (st.expiresAt.getTime() <= now.getTime()) throw new AppError('invalid', '绑定链接已过期（10 分钟内有效），请重新扫码');
  if (!input.code) throw new AppError('invalid', '没有完成企业微信授权，请重新扫码');
  const app = await withOrg(db, actor.orgId, async (tx) => (await tx.select().from(wecomApps).where(eq(wecomApps.orgId, actor.orgId)))[0] ?? null);
  if (!app?.bindEnabled) throw new AppError('invalid', '组织已关闭企业微信扫码绑定');
  const { secret } = decryptConfig<{ secret: string }>(app.secret, deps.secretKey);
  const token = await wecomGet<WecomReply & { access_token?: string }>(deps, '/cgi-bin/gettoken', { corpid: app.corpId, corpsecret: secret });
  if (token.errcode !== 0 || !token.access_token) throw wecomError(token);
  const info = await wecomGet<WecomReply & { userid?: string }>(deps, '/cgi-bin/auth/getuserinfo', { access_token: token.access_token, code: input.code });
  if (info.errcode !== 0) throw wecomError(info);
  if (!info.userid) throw new AppError('invalid', '扫码的不是本企业的成员，无法绑定');
  if (!WECOM_USERID_RE.test(info.userid)) throw new AppError('invalid', '企业微信返回的账号格式无法识别');
  const userid = info.userid;
  await withOrg(db, actor.orgId, (tx) => writeWecomUseridTx(tx, actor, actor.memberId, userid, 'oauth'));
  return { userid };
}
