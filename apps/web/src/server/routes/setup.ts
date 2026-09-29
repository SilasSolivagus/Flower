import { createSession, getInstanceStatus, initializeInstance } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson, sessionMeta, setSessionCookie } from '../http';

const setupSchema = z.object({
  admin: z.object({ email: z.string().max(254), name: z.string(), password: z.string().max(256) }),
  org: z.object({ name: z.string(), slug: z.string() }),
});

export function registerSetupRoutes(app: App, deps: ApiDeps): void {
  app.get('/setup/status', async (c) => c.json(await getInstanceStatus(deps.db)));

  app.post('/setup', async (c) => {
    const body = await readJson(c, setupSchema);
    const r = await initializeInstance(deps.db, body);
    const s = await createSession(deps.db, r.account.id, sessionMeta(c));
    setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies);
    return c.json({ account: r.account, org: r.org }, 201);
  });
}
