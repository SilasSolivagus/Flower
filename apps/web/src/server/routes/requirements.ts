import {
  addRequirementComment,
  CHECK_STATES,
  createBlocker,
  createRelation,
  createRequirement,
  deleteRelation,
  getRequirementByKey,
  listProductIterations,
  listRequirementComments,
  listRequirements,
  listStructureNodes,
  markRequirementCommentsRead,
  RELATION_TYPES,
  type RequirementFilter,
  resolveBlocker,
  setCheckItemState,
  setRequirementField,
  signCheckItem,
  transitionRequirement,
  updateRequirement,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, ApiEnv, App } from '../api';
import { readJson } from '../http';

const csv = (v: string | undefined): string[] | undefined => {
  const list = v?.split(',').map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : undefined;
};

function filterFrom(c: Context<ApiEnv>): RequirementFilter {
  const q = (k: string) => c.req.query(k);
  const sort = q('sort');
  const num = (k: string) => {
    const n = Number.parseInt(q(k) ?? '', 10);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    states: csv(q('state')),
    nodeIds: csv(q('node')),
    priorityOptionIds: csv(q('priority')),
    platformOptionIds: csv(q('platform')),
    ownerIds: csv(q('owner')),
    requesterIds: csv(q('requester')),
    iterationIds: csv(q('iteration')),
    noIteration: q('noIteration') === '1',
    q: q('q') || undefined,
    sort: sort === 'number' || sort === 'created' ? sort : 'updated',
    page: num('page'),
    pageSize: num('pageSize'),
  };
}

export function registerRequirementRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/requirements', async (c) =>
    c.json(await listRequirements(deps.db, c.get('actor'), c.req.param('id'), filterFrom(c))),
  );

  app.post('/orgs/:org/products/:id/requirements', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string(),
        description: z.string().optional(),
        ownerMemberId: z.string().nullable().optional(),
        requesterMemberId: z.string().nullable().optional(),
        nodeId: z.string().nullable().optional(),
        fields: z.record(z.string(), z.array(z.string())).optional(),
      }),
    );
    return c.json({ requirement: await createRequirement(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.get('/orgs/:org/products/:id/nodes', async (c) => c.json({ nodes: await listStructureNodes(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/products/:id/iterations', async (c) =>
    c.json({ iterations: await listProductIterations(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.get('/orgs/:org/requirements/:key', async (c) =>
    c.json({ requirement: await getRequirementByKey(deps.db, c.get('actor'), c.req.param('key')) }),
  );

  app.patch('/orgs/:org/requirements/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        ownerMemberId: z.string().nullable().optional(),
        requesterMemberId: z.string().nullable().optional(),
        nodeId: z.string().nullable().optional(),
      }),
    );
    return c.json({ requirement: await updateRequirement(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/requirements/:id/fields/:fieldKey', async (c) => {
    const body = await readJson(c, z.object({ optionIds: z.array(z.string()) }));
    return c.json({ options: await setRequirementField(deps.db, c.get('actor'), c.req.param('id'), c.req.param('fieldKey'), body.optionIds) });
  });

  app.post('/orgs/:org/requirements/:id/transitions', async (c) => {
    const body = await readJson(c, z.object({ to: z.string(), force: z.boolean().optional(), reason: z.string().max(500).optional() }));
    return c.json(await transitionRequirement(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.put('/orgs/:org/requirements/:id/checks/:itemKey', async (c) => {
    const body = await readJson(c, z.object({ state: z.enum(CHECK_STATES), note: z.string().max(2000).nullable().optional() }));
    return c.json(await setCheckItemState(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body));
  });

  app.post('/orgs/:org/requirements/:id/checks/:itemKey/signoffs', async (c) => {
    const body = await readJson(
      c,
      z.object({
        decision: z.enum(['passed', 'rejected']),
        note: z.string().max(2000).nullable().optional(),
        ruleIndex: z.number().int().min(0).optional(),
        onBehalf: z.boolean().optional(),
      }),
    );
    return c.json(await signCheckItem(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body), 201);
  });

  app.get('/orgs/:org/requirements/:id/comments', async (c) =>
    c.json({ comments: await listRequirementComments(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.post('/orgs/:org/requirements/:id/comments', async (c) => {
    const body = await readJson(
      c,
      z.object({ body: z.string().max(10_000), kind: z.enum(['comment', 'update']).optional(), parentId: z.string().nullable().optional() }),
    );
    return c.json({ comment: await addRequirementComment(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.post('/orgs/:org/requirements/:id/comments/read', async (c) =>
    c.json({ marked: await markRequirementCommentsRead(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.post('/orgs/:org/requirements/:id/blockers', async (c) => {
    const body = await readJson(c, z.object({ description: z.string().max(500), ownerMemberId: z.string().nullable().optional() }));
    return c.json({ blocker: await createBlocker(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.post('/orgs/:org/blockers/:id/resolve', async (c) => c.json({ blocker: await resolveBlocker(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/requirements/:id/relations', async (c) => {
    const body = await readJson(c, z.object({ toId: z.string(), type: z.enum(RELATION_TYPES) }));
    return c.json({ relation: await createRelation(deps.db, c.get('actor'), { fromId: c.req.param('id'), toId: body.toId, type: body.type }) }, 201);
  });

  app.delete('/orgs/:org/relations/:id', async (c) => {
    await deleteRelation(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
}
