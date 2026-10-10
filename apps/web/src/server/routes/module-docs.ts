import {
  addAffectedNode,
  AFFECTED_CHANGE_TYPES,
  applyMerge,
  AppError,
  createModuleDocument,
  createNodeForDocument,
  getMergePlan,
  listAffectedNodes,
  listMergeRecords,
  listModuleDocuments,
  removeAffectedNode,
  reopenMerge,
  skipMerge,
  updateAffectedNode,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const sourceSections = z.array(z.string().max(500)).max(20);
const uuidParam = z.string().uuid();

/** 校验路径参数是合法的 UUID，否则报 400（而不是让 Postgres 的 22P02 落到 http.ts 的 404 兜底）。 */
function idParam(c: Context, name: string, message: string): string {
  const v = c.req.param(name);
  const r = uuidParam.safeParse(v);
  if (!r.success) throw new AppError('invalid', message);
  return r.data;
}

export function registerModuleDocRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/module-documents', async (c) =>
    c.json({ tree: await listModuleDocuments(deps.db, c.get('actor'), idParam(c, 'id', '产品无效')) }),
  );

  app.post('/orgs/:org/nodes/:id/module-document', async (c) =>
    c.json({ document: await createModuleDocument(deps.db, c.get('actor'), idParam(c, 'id', '节点无效')) }),
  );

  app.get('/orgs/:org/documents/:id/affected-nodes', async (c) =>
    c.json({ affected: await listAffectedNodes(deps.db, c.get('actor'), idParam(c, 'id', 'PRD 无效')) }),
  );

  app.post('/orgs/:org/documents/:id/affected-nodes', async (c) => {
    const id = idParam(c, 'id', 'PRD 无效');
    const body = await readJson(c, z.object({ nodeId: uuidParam, changeType: z.enum(AFFECTED_CHANGE_TYPES), sourceSections: sourceSections.optional() }));
    return c.json({ affected: await addAffectedNode(deps.db, c.get('actor'), id, body) }, 201);
  });

  app.post('/orgs/:org/documents/:id/affected-nodes/new-node', async (c) => {
    const id = idParam(c, 'id', 'PRD 无效');
    const body = await readJson(c, z.object({ parentId: uuidParam, name: z.string() }));
    return c.json({ node: await createNodeForDocument(deps.db, c.get('actor'), id, body) }, 201);
  });

  app.patch('/orgs/:org/documents/:id/affected-nodes/:nodeId', async (c) => {
    const id = idParam(c, 'id', 'PRD 无效');
    const nodeId = idParam(c, 'nodeId', '节点无效');
    const body = await readJson(c, z.object({ changeType: z.enum(AFFECTED_CHANGE_TYPES).optional(), sourceSections: sourceSections.optional() }));
    return c.json({ affected: await updateAffectedNode(deps.db, c.get('actor'), id, nodeId, body) });
  });

  app.delete('/orgs/:org/documents/:id/affected-nodes/:nodeId', async (c) =>
    c.json({ affected: await removeAffectedNode(deps.db, c.get('actor'), idParam(c, 'id', 'PRD 无效'), idParam(c, 'nodeId', '节点无效')) }),
  );

  app.get('/orgs/:org/documents/:id/merge', async (c) => c.json({ plan: await getMergePlan(deps.db, c.get('actor'), idParam(c, 'id', 'PRD 无效')) }));

  app.post('/orgs/:org/documents/:id/merge/:nodeId/apply', async (c) => {
    const id = idParam(c, 'id', 'PRD 无效');
    const nodeId = idParam(c, 'nodeId', '节点无效');
    const body = await readJson(c, z.object({ baseVersion: z.number().int().nullable(), body: z.string().max(300_000) }));
    return c.json({ result: await applyMerge(deps.db, c.get('actor'), id, nodeId, body) });
  });

  app.post('/orgs/:org/documents/:id/merge/:nodeId/skip', async (c) =>
    c.json({ result: await skipMerge(deps.db, c.get('actor'), idParam(c, 'id', 'PRD 无效'), idParam(c, 'nodeId', '节点无效')) }),
  );

  app.post('/orgs/:org/documents/:id/merge/:nodeId/reopen', async (c) =>
    c.json({ result: await reopenMerge(deps.db, c.get('actor'), idParam(c, 'id', 'PRD 无效'), idParam(c, 'nodeId', '节点无效')) }),
  );

  app.get('/orgs/:org/documents/:id/merge-records', async (c) =>
    c.json({ records: await listMergeRecords(deps.db, c.get('actor'), idParam(c, 'id', 'PRD 无效')) }),
  );
}
