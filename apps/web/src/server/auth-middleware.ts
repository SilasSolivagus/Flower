import {
  type AccountView,
  type Actor,
  AppError,
  authenticateToken,
  resolveActor,
  resolveSession,
  SESSION_COOKIE,
} from '@flower/core';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { ApiDeps, ApiEnv } from './api';

export const authenticate = (deps: ApiDeps) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    c.set('account', null);
    c.set('tokenAuth', null);
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
      const r = await authenticateToken(deps.db, auth.slice('Bearer '.length).trim());
      if (!r) throw new AppError('unauthenticated', 'API Token 无效、已撤销或已过期');
      c.set('tokenAuth', r);
    } else {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) c.set('account', await resolveSession(deps.db, token));
    }
    await next();
  });

export function requireAccount(c: Context<ApiEnv>): AccountView {
  const account = c.get('account');
  if (!account) throw new AppError('unauthenticated', '请先登录');
  return account;
}

/** 解析 /orgs/:org 下的操作者：Token 必须属于该组织，会话用户必须是该组织成员。 */
export const orgActor = (deps: ApiDeps) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    const slug = c.req.param('org') ?? '';
    const tokenAuth = c.get('tokenAuth');
    let actor: Actor | null;
    if (tokenAuth) {
      actor = tokenAuth.orgSlug === slug ? tokenAuth.actor : null;
    } else {
      actor = await resolveActor(deps.db, requireAccount(c).id, slug);
    }
    if (!actor) throw new AppError('not_found', '组织不存在');
    c.set('actor', actor);
    await next();
  });
