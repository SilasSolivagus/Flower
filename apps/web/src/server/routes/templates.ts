import { AppError, createPresetTemplate, createTemplate, listTemplates, TEMPLATE_KINDS, updateTemplate } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const sections = z
  .array(z.object({ heading: z.string().max(100), required: z.boolean(), guidance: z.string().max(500).optional() }))
  .max(50);
const kindSchema = z.enum(TEMPLATE_KINDS);

/** 地址栏里的模板类型，缺省为变更 PRD。 */
function kindOf(v: string | undefined) {
  const r = kindSchema.safeParse(v || 'change');
  if (!r.success) throw new AppError('invalid', '模板类型无效');
  return r.data;
}

export function registerTemplateRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/templates', async (c) =>
    c.json({
      templates: await listTemplates(deps.db, c.get('actor'), {
        productId: c.req.query('product') || null,
        usable: c.req.query('usable') === '1',
        kind: kindOf(c.req.query('kind')),
      }),
    }),
  );

  app.post('/orgs/:org/templates', async (c) => {
    const body = await readJson(
      c,
      z.object({ productId: z.string().nullable().optional(), kind: kindSchema.optional(), name: z.string(), body: z.string(), sections, guidance: z.string().max(5000).optional() }),
    );
    return c.json({ template: await createTemplate(deps.db, c.get('actor'), body) }, 201);
  });

  app.post('/orgs/:org/templates/preset', async (c) => c.json({ template: await createPresetTemplate(deps.db, c.get('actor'), kindOf(c.req.query('kind'))) }, 201));

  app.patch('/orgs/:org/templates/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({ name: z.string().optional(), body: z.string().optional(), sections: sections.optional(), guidance: z.string().max(5000).optional(), active: z.boolean().optional() }),
    );
    return c.json({ template: await updateTemplate(deps.db, c.get('actor'), c.req.param('id'), body) });
  });
}
