import { createOrganization, getOrganization, listMyOrganizations, updateOrganization } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';
import { readJson } from '../http';

export function registerOrgRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs', async (c) => c.json({ orgs: await listMyOrganizations(deps.db, requireAccount(c).id) }));

  app.post('/orgs', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(c, z.object({ name: z.string(), slug: z.string() }));
    const { org } = await createOrganization(deps.db, account, body);
    return c.json({ org }, 201);
  });

  app.get('/orgs/:org', async (c) => {
    const actor = c.get('actor');
    return c.json({ org: await getOrganization(deps.db, actor), me: { memberId: actor.memberId, orgRole: actor.orgRole } });
  });

  app.patch('/orgs/:org', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), timezone: z.string().optional() }));
    return c.json({ org: await updateOrganization(deps.db, c.get('actor'), body) });
  });
}
