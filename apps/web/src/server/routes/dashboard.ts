import { AppError, type DashboardRange, getOrgDashboard, getProductDashboard } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { idParam } from './notifications';

const rangeQuery = z.object({
  range: z.enum(['30', '90', '180']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  iteration: z.string().uuid().optional(),
});

/** 查询参数 → 时间段：有 iteration 时按迭代；有 from 或 to 时为自定义（两者都要）；否则近 N 天（默认 90）。日期本身由服务校验。 */
function parseRange(raw: Record<string, string>): DashboardRange {
  const q = rangeQuery.safeParse(raw);
  if (!q.success) throw new AppError('invalid', '时间段参数无效');
  const { range, from, to, iteration } = q.data;
  if (iteration) return { kind: 'iteration', iterationId: iteration };
  if (from !== undefined || to !== undefined) {
    if (!from || !to) throw new AppError('invalid', '自定义时间段需要开始和结束日期');
    return { kind: 'custom', from, to };
  }
  return { kind: 'days', days: range === '30' ? 30 : range === '180' ? 180 : 90 };
}

export function registerDashboardRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/dashboard', async (c) =>
    c.json({ dashboard: await getProductDashboard(deps.db, c.get('actor'), idParam(c, 'id', '产品无效'), { range: parseRange(c.req.query()) }) }),
  );

  app.get('/orgs/:org/dashboard', async (c) => c.json({ dashboard: await getOrgDashboard(deps.db, c.get('actor'), { range: parseRange(c.req.query()) }) }));
}
