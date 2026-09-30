import { createStructureNode, moveStructureNode, reorderStructureNodes, updateStructureNode } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerStructureRoutes(app: App, deps: ApiDeps): void {
  app.post('/orgs/:org/products/:id/nodes', async (c) => {
    const body = await readJson(c, z.object({ parentId: z.string().nullable().optional(), name: z.string(), description: z.string().nullable().optional() }));
    return c.json({ node: await createStructureNode(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.put('/orgs/:org/products/:id/nodes/order', async (c) => {
    const body = await readJson(c, z.object({ parentId: z.string().nullable(), nodeIds: z.array(z.string()) }));
    return c.json({ nodes: await reorderStructureNodes(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.patch('/orgs/:org/nodes/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({ name: z.string().optional(), description: z.string().nullable().optional(), status: z.enum(['active', 'deprecated']).optional() }),
    );
    return c.json({ node: await updateStructureNode(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.post('/orgs/:org/nodes/:id/move', async (c) => {
    const body = await readJson(c, z.object({ parentId: z.string().nullable() }));
    return c.json({ node: await moveStructureNode(deps.db, c.get('actor'), c.req.param('id'), body) });
  });
}
