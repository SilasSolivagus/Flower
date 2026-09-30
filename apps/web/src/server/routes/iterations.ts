import {
  createIteration,
  deleteIteration,
  getIteration,
  getIterationScope,
  listIterations,
  setIterationStatus,
  setRequirementIteration,
  updateIteration,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const milestones = z.array(z.object({ label: z.string(), date: z.string() })).max(20);

export function registerIterationRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/iterations', async (c) =>
    c.json({ iterations: await listIterations(deps.db, c.get('actor'), { productId: c.req.query('product') || undefined }) }),
  );

  app.post('/orgs/:org/iterations', async (c) => {
    const body = await readJson(
      c,
      z.object({
        type: z.enum(['regular', 'special']),
        productId: z.string().nullable().optional(),
        name: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        milestones: milestones.optional(),
      }),
    );
    return c.json({ iteration: await createIteration(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/iterations/:id', async (c) => c.json({ iteration: await getIteration(deps.db, c.get('actor'), c.req.param('id')) }));

  app.patch('/orgs/:org/iterations/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({ name: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(), milestones: milestones.optional() }),
    );
    return c.json({ iteration: await updateIteration(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.post('/orgs/:org/iterations/:id/status', async (c) => {
    const body = await readJson(c, z.object({ to: z.enum(['planning', 'active', 'done', 'canceled']) }));
    return c.json({ iteration: await setIterationStatus(deps.db, c.get('actor'), c.req.param('id'), body.to) });
  });

  app.delete('/orgs/:org/iterations/:id', async (c) => {
    await deleteIteration(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get('/orgs/:org/iterations/:id/scope', async (c) => c.json({ scope: await getIterationScope(deps.db, c.get('actor'), c.req.param('id')) }));

  app.put('/orgs/:org/requirements/:id/iteration', async (c) => {
    const body = await readJson(c, z.object({ iterationId: z.string().nullable(), force: z.boolean().optional(), reason: z.string().max(500).optional() }));
    return c.json(await setRequirementIteration(deps.db, c.get('actor'), c.req.param('id'), body));
  });
}
