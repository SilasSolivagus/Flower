import { AppError, CHECK_STATES, listReviewQueue, REVIEW_FILTER_STATES } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';

const reviewQuery = z.object({
  state: z.enum(REVIEW_FILTER_STATES).optional(),
  item: z.string().optional(),
  itemState: z.enum(CHECK_STATES).optional(),
  mine: z.literal('1').optional(),
});

export function registerReviewRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/reviews', async (c) => {
    const q = reviewQuery.safeParse(c.req.query());
    if (!q.success) throw new AppError('invalid', '筛选条件无效');
    const queue = await listReviewQueue(deps.db, c.get('actor'), c.req.param('id'), {
      state: q.data.state,
      itemKey: q.data.item,
      itemState: q.data.itemState,
      waitingForMe: q.data.mine === '1',
    });
    return c.json({ queue });
  });
}
