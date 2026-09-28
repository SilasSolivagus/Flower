import {
  createAgentMember,
  createFunctionTag,
  createPlaceholderMember,
  deleteFunctionTag,
  listFunctionTags,
  listMembers,
  ORG_ROLES,
  setMemberFunctionTags,
  updateFunctionTag,
  updateMember,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerMemberRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/members', async (c) => c.json({ members: await listMembers(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/members', async (c) => {
    const body = await readJson(c, z.object({ displayName: z.string(), email: z.string().optional(), department: z.string().optional() }));
    return c.json({ member: await createPlaceholderMember(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/members/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        displayName: z.string().optional(),
        email: z.string().nullable().optional(),
        department: z.string().nullable().optional(),
        orgRole: z.enum(ORG_ROLES).optional(),
        status: z.enum(['active', 'left']).optional(),
      }),
    );
    return c.json({ member: await updateMember(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/members/:id/function-tags', async (c) => {
    const body = await readJson(c, z.object({ tagIds: z.array(z.string()) }));
    return c.json({ member: await setMemberFunctionTags(deps.db, c.get('actor'), c.req.param('id'), body.tagIds) });
  });

  app.post('/orgs/:org/agents', async (c) => {
    const body = await readJson(c, z.object({ displayName: z.string(), orgRole: z.enum(['member', 'guest']).optional() }));
    return c.json({ member: await createAgentMember(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/function-tags', async (c) => c.json({ tags: await listFunctionTags(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/function-tags', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), color: z.string() }));
    return c.json({ tag: await createFunctionTag(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/function-tags/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), color: z.string().optional(), sort: z.number().int().optional() }));
    return c.json({ tag: await updateFunctionTag(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.delete('/orgs/:org/function-tags/:id', async (c) => {
    await deleteFunctionTag(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
}
