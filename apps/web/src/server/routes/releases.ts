import { createRelease, linkRequirementRelease, listReleases, markReleaseReleased, unlinkRequirementRelease, updateRelease } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerReleaseRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/releases', async (c) =>
    c.json({
      releases: await listReleases(deps.db, c.get('actor'), { productId: c.req.query('product') || undefined, iterationId: c.req.query('iteration') || undefined }),
    }),
  );

  app.post('/orgs/:org/releases', async (c) => {
    const body = await readJson(
      c,
      z.object({
        productId: z.string(),
        versionName: z.string(),
        platformOptionId: z.string().nullable().optional(),
        iterationId: z.string().nullable().optional(),
        plannedDate: z.string(),
        notes: z.string().nullable().optional(),
      }),
    );
    return c.json({ release: await createRelease(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/releases/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        versionName: z.string().optional(),
        platformOptionId: z.string().nullable().optional(),
        iterationId: z.string().nullable().optional(),
        plannedDate: z.string().optional(),
        notes: z.string().nullable().optional(),
      }),
    );
    return c.json({ release: await updateRelease(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.post('/orgs/:org/releases/:id/released', async (c) => c.json({ release: await markReleaseReleased(deps.db, c.get('actor'), c.req.param('id')) }));

  app.put('/orgs/:org/releases/:id/requirements/:requirementId', async (c) => {
    await linkRequirementRelease(deps.db, c.get('actor'), c.req.param('id'), c.req.param('requirementId'));
    return c.body(null, 204);
  });

  app.delete('/orgs/:org/releases/:id/requirements/:requirementId', async (c) => {
    await unlinkRequirementRelease(deps.db, c.get('actor'), c.req.param('id'), c.req.param('requirementId'));
    return c.body(null, 204);
  });
}
