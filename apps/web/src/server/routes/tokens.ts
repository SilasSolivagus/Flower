import { issueToken, listTokens, revokeToken, tokenScopeSchema } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerTokenRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/tokens', async (c) => c.json({ tokens: await listTokens(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/tokens', async (c) => {
    const body = await readJson(
      c,
      z.object({ memberId: z.string(), name: z.string(), scope: tokenScopeSchema, expiresAt: z.coerce.date().nullable().optional() }),
    );
    const r = await issueToken(deps.db, c.get('actor'), body);
    return c.json(r, 201);
  });

  app.delete('/orgs/:org/tokens/:id', async (c) => {
    await revokeToken(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
}
