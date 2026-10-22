import { createRequirementTag, deleteRequirementTag, listRequirementTags, setRequirementTags, updateRequirementTag } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';
import { idParam } from './notifications';

const uuid = z.string().uuid();

export function registerRequirementTagRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/requirement-tags', async (c) => c.json({ tags: await listRequirementTags(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/requirement-tags', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), color: z.string().optional() }));
    return c.json({ tag: await createRequirementTag(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/requirement-tags/:id', async (c) => {
    const id = idParam(c, 'id', '标签不存在');
    const body = await readJson(c, z.object({ name: z.string().optional(), color: z.string().optional() }));
    return c.json({ tag: await updateRequirementTag(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/requirement-tags/:id', async (c) => {
    await deleteRequirementTag(deps.db, c.get('actor'), idParam(c, 'id', '标签不存在'));
    return c.body(null, 204);
  });

  app.put('/orgs/:org/requirements/:id/tags', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, z.object({ tagIds: z.array(uuid) }));
    return c.json({ tags: await setRequirementTags(deps.db, c.get('actor'), id, body.tagIds) });
  });
}
