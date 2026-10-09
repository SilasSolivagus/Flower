import { AppError, BACKLINK_TARGET_TYPES, listBacklinks, listDocumentLinkCards, searchLinkTargets } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';

const backlinkQuery = z.object({ type: z.enum(BACKLINK_TARGET_TYPES), id: z.string().uuid() });
const uuidParam = z.string().uuid();

export function registerLinkRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/links/search', async (c) => {
    const productId = c.req.query('product');
    if (!productId) throw new AppError('invalid', '缺少产品');
    const q = (c.req.query('q') ?? '').slice(0, 100);
    return c.json({ suggestions: await searchLinkTargets(deps.db, c.get('actor'), { productId, q }) });
  });

  app.get('/orgs/:org/backlinks', async (c) => {
    const parsed = backlinkQuery.safeParse({ type: c.req.query('type'), id: c.req.query('id') });
    if (!parsed.success) throw new AppError('invalid', '引用目标无效');
    return c.json({ groups: await listBacklinks(deps.db, c.get('actor'), parsed.data) });
  });

  app.get('/orgs/:org/documents/:id/links', async (c) => {
    const id = c.req.param('id');
    if (!uuidParam.safeParse(id).success) throw new AppError('invalid', 'PRD 无效');
    return c.json({ cards: await listDocumentLinkCards(deps.db, c.get('actor'), id) });
  });
}
