import { createPresetTemplate, createTemplate, listTemplates, updateTemplate } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const sections = z
  .array(z.object({ heading: z.string().max(100), required: z.boolean(), guidance: z.string().max(500).optional() }))
  .max(50);

export function registerTemplateRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/templates', async (c) =>
    c.json({ templates: await listTemplates(deps.db, c.get('actor'), { productId: c.req.query('product') || null, usable: c.req.query('usable') === '1' }) }),
  );

  app.post('/orgs/:org/templates', async (c) => {
    const body = await readJson(c, z.object({ productId: z.string().nullable().optional(), name: z.string(), body: z.string(), sections }));
    return c.json({ template: await createTemplate(deps.db, c.get('actor'), body) }, 201);
  });

  app.post('/orgs/:org/templates/preset', async (c) => c.json({ template: await createPresetTemplate(deps.db, c.get('actor')) }, 201));

  app.patch('/orgs/:org/templates/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), body: z.string().optional(), sections: sections.optional(), active: z.boolean().optional() }));
    return c.json({ template: await updateTemplate(deps.db, c.get('actor'), c.req.param('id'), body) });
  });
}
