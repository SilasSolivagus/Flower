import {
  createProduct,
  getProduct,
  listProductMemberRoles,
  listProductRoles,
  listProducts,
  PRODUCT_ROLES,
  setProductRole,
  updateProduct,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerProductRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products', async (c) => c.json({ products: await listProducts(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/products', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), key: z.string(), workflowVersionId: z.string().optional() }));
    return c.json({ product: await createProduct(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/products/:id', async (c) =>
    c.json({ product: await getProduct(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.patch('/orgs/:org/products/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), status: z.enum(['active', 'archived']).optional() }));
    return c.json({ product: await updateProduct(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.get('/orgs/:org/products/:id/roles', async (c) =>
    c.json({ roles: await listProductRoles(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.put('/orgs/:org/products/:id/roles/:memberId', async (c) => {
    const body = await readJson(c, z.object({ role: z.enum(PRODUCT_ROLES).nullable() }));
    await setProductRole(deps.db, c.get('actor'), c.req.param('id'), c.req.param('memberId'), body.role);
    return c.body(null, 204);
  });

  app.get('/orgs/:org/products/:id/members', async (c) =>
    c.json({ members: await listProductMemberRoles(deps.db, c.get('actor'), c.req.param('id')) }),
  );
}
