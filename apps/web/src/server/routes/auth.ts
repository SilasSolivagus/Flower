import {
  changePassword,
  createSession,
  listMyOrganizations,
  login,
  revokeSession,
  SESSION_COOKIE,
  signUp,
  updateProfile,
} from '@flower/core';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';
import { clearSessionCookie, readJson, sessionMeta, setSessionCookie } from '../http';

export function registerAuthRoutes(app: App, deps: ApiDeps): void {
  app.post('/auth/login', async (c) => {
    const body = await readJson(c, z.object({ email: z.string().max(254), password: z.string().max(256) }));
    const r = await login(deps.db, body, sessionMeta(c));
    setSessionCookie(c, r.token, r.expiresAt, deps.secureCookies);
    return c.json({ account: r.account });
  });

  app.post('/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSession(deps.db, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.post('/auth/register', async (c) => {
    const body = await readJson(c, z.object({ email: z.string().max(254), name: z.string(), password: z.string().max(256) }));
    const account = await signUp(deps.db, body);
    const s = await createSession(deps.db, account.id, sessionMeta(c));
    setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies);
    return c.json({ account }, 201);
  });

  app.get('/me', async (c) => {
    const account = requireAccount(c);
    return c.json({ account, orgs: await listMyOrganizations(deps.db, account.id) });
  });

  app.patch('/me', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(
      c,
      z.object({
        name: z.string().optional(),
        preferences: z
          .object({ theme: z.enum(['light', 'dark', 'system']).optional(), locale: z.string().optional(), timezone: z.string().optional() })
          .optional(),
      }),
    );
    return c.json({ account: await updateProfile(deps.db, account.id, body) });
  });

  app.post('/me/password', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(c, z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }));
    const keepSessionToken = getCookie(c, SESSION_COOKIE);
    await changePassword(deps.db, account.id, { ...body, keepSessionToken });
    return c.body(null, 204);
  });
}
