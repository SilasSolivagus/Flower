import {
  addFieldOption,
  createWorkflowTemplate,
  forkFieldForProduct,
  forkWorkflowForProduct,
  getLevelNames,
  getProductWorkflow,
  getWorkflowDefinition,
  listFields,
  listWorkflowTemplates,
  publishWorkflowVersion,
  reorderFieldOptions,
  setOrgLevelNames,
  setProductLevelNames,
  setProductWorkflowVersion,
  updateFieldOption,
  updateWorkflowDefinition,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerDefinitionRoutes(app: App, deps: ApiDeps): void {
  // 流程
  app.get('/orgs/:org/workflows', async (c) => c.json({ workflows: await listWorkflowTemplates(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/workflows', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), body: z.unknown(), note: z.string().optional() }));
    return c.json(await createWorkflowTemplate(deps.db, c.get('actor'), body), 201);
  });

  app.get('/orgs/:org/workflows/:id', async (c) =>
    c.json(await getWorkflowDefinition(deps.db, c.get('actor'), c.req.param('id'))),
  );

  app.patch('/orgs/:org/workflows/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), archived: z.boolean().optional() }));
    return c.json({ workflow: await updateWorkflowDefinition(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.post('/orgs/:org/workflows/:id/versions', async (c) => {
    const body = await readJson(c, z.object({ body: z.unknown(), note: z.string().optional() }));
    return c.json({ version: await publishWorkflowVersion(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.get('/orgs/:org/products/:id/workflow', async (c) =>
    c.json(await getProductWorkflow(deps.db, c.get('actor'), c.req.param('id'))),
  );

  app.put('/orgs/:org/products/:id/workflow', async (c) => {
    const body = await readJson(c, z.object({ versionId: z.string() }));
    await setProductWorkflowVersion(deps.db, c.get('actor'), c.req.param('id'), body.versionId);
    return c.body(null, 204);
  });

  app.post('/orgs/:org/products/:id/workflow/fork', async (c) => {
    const body = await readJson(c, z.object({ fromVersionId: z.string() }));
    return c.json(await forkWorkflowForProduct(deps.db, c.get('actor'), c.req.param('id'), body), 201);
  });

  // 字段字典
  app.get('/orgs/:org/fields', async (c) =>
    c.json({ fields: await listFields(deps.db, c.get('actor'), { productId: c.req.query('product') || undefined }) }),
  );

  app.post('/orgs/:org/fields/:fieldId/options', async (c) => {
    const body = await readJson(c, z.object({ label: z.string(), color: z.string().nullable().optional(), key: z.string().optional() }));
    return c.json({ option: await addFieldOption(deps.db, c.get('actor'), c.req.param('fieldId'), body) }, 201);
  });

  app.put('/orgs/:org/fields/:fieldId/options/order', async (c) => {
    const body = await readJson(c, z.object({ optionIds: z.array(z.string()) }));
    return c.json({ options: await reorderFieldOptions(deps.db, c.get('actor'), c.req.param('fieldId'), body.optionIds) });
  });

  app.patch('/orgs/:org/field-options/:optionId', async (c) => {
    const body = await readJson(
      c,
      z.object({ label: z.string().optional(), color: z.string().nullable().optional(), active: z.boolean().optional() }),
    );
    return c.json({ option: await updateFieldOption(deps.db, c.get('actor'), c.req.param('optionId'), body) });
  });

  app.post('/orgs/:org/products/:id/fields/:fieldId/fork', async (c) =>
    c.json({ field: await forkFieldForProduct(deps.db, c.get('actor'), c.req.param('id'), c.req.param('fieldId')) }, 201),
  );

  // 结构树层级叫法
  app.get('/orgs/:org/level-names', async (c) => c.json(await getLevelNames(deps.db, c.get('actor'))));

  app.put('/orgs/:org/level-names', async (c) => {
    const body = await readJson(c, z.object({ names: z.array(z.string()) }));
    return c.json({ names: await setOrgLevelNames(deps.db, c.get('actor'), body.names) });
  });

  app.get('/orgs/:org/products/:id/level-names', async (c) =>
    c.json(await getLevelNames(deps.db, c.get('actor'), c.req.param('id'))),
  );

  app.put('/orgs/:org/products/:id/level-names', async (c) => {
    const body = await readJson(c, z.object({ names: z.array(z.string()).nullable() }));
    await setProductLevelNames(deps.db, c.get('actor'), c.req.param('id'), body.names);
    return c.body(null, 204);
  });
}
