import {
  AppError,
  BRIEF_STATUSES,
  briefContextMarkdown,
  convertBriefToPrd,
  createBrief,
  getBriefContext,
  getBriefGate,
  listBriefs,
  setBriefGateCheck,
  updateBrief,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { csvParam as csv, readJson } from '../http';
import { idParam } from './notifications';

const uuid = z.string().uuid();
const listQuery = z.object({ product: uuid.optional(), status: z.array(z.enum(BRIEF_STATUSES)).optional(), decider: uuid.optional() });
const relatedLink = z.union([
  z.object({ kind: z.literal('wiki'), target: z.string().max(200), note: z.string().max(200) }),
  z.object({ kind: z.literal('url'), url: z.string().max(2000), note: z.string().max(200) }),
]);
const headerBody = z.object({
  version: z.string().max(100).optional(),
  requesterMemberId: uuid.nullable().optional(),
  deciderMemberId: uuid.nullable().optional(),
  authorMemberId: uuid.nullable().optional(),
  participantTagIds: z.array(uuid).max(50).optional(),
  relatedLinks: z.array(relatedLink).max(50).optional(),
});
const briefId = (c: Context) => idParam(c, 'id', '简报无效');

export function registerBriefRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/briefs', async (c) => {
    const q = listQuery.safeParse({ product: c.req.query('product') || undefined, status: csv(c.req.query('status')), decider: c.req.query('decider') || undefined });
    if (!q.success) throw new AppError('invalid', '筛选参数无效');
    return c.json({ briefs: await listBriefs(deps.db, c.get('actor'), { productId: q.data.product, statuses: q.data.status, deciderId: q.data.decider }) });
  });

  app.post('/orgs/:org/products/:id/briefs', async (c) => {
    const productId = idParam(c, 'id', '产品无效');
    const body = await readJson(c, z.object({ title: z.string(), templateId: uuid.nullable().optional(), requirementIds: z.array(uuid).max(200).optional() }));
    return c.json({ document: await createBrief(deps.db, c.get('actor'), productId, body) }, 201);
  });

  app.patch('/orgs/:org/briefs/:id', async (c) => {
    const id = briefId(c);
    const body = await readJson(c, headerBody);
    return c.json({ document: await updateBrief(deps.db, c.get('actor'), id, body) });
  });

  app.get('/orgs/:org/briefs/:id/gate', async (c) => c.json({ gate: await getBriefGate(deps.db, c.get('actor'), briefId(c)) }));

  app.put('/orgs/:org/briefs/:id/gate/:item', async (c) => {
    const id = briefId(c);
    const item = Number(c.req.param('item'));
    if (!Number.isInteger(item)) throw new AppError('invalid', '闸口项不存在');
    const body = await readJson(c, z.object({ checked: z.boolean() }));
    return c.json({ gate: await setBriefGateCheck(deps.db, c.get('actor'), id, item, body) });
  });

  app.post('/orgs/:org/briefs/:id/convert', async (c) => {
    const id = briefId(c);
    const body = await readJson(c, z.object({ again: z.boolean().optional() }));
    return c.json(await convertBriefToPrd(deps.db, c.get('actor'), id, body), 201);
  });

  app.get('/orgs/:org/briefs/:id/context', async (c) => {
    const id = briefId(c);
    const format = c.req.query('format') ?? 'markdown';
    if (format !== 'markdown' && format !== 'json') throw new AppError('invalid', '格式只能是 markdown 或 json');
    const context = await getBriefContext(deps.db, c.get('actor'), id);
    if (format === 'json') return c.json({ context });
    return c.body(briefContextMarkdown(context), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });
}
