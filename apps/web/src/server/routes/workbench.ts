import { getWorkbench } from '@flower/core';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';

export function registerWorkbenchRoutes(app: App, deps: ApiDeps): void {
  // 跨组织汇总只对登录会话开放；API Token 绑定单个组织，requireAccount 会返回 401
  app.get('/me/workbench', async (c) => {
    const org = c.req.query('org')?.trim();
    return c.json({ workbench: await getWorkbench(deps.db, requireAccount(c).id, { orgSlug: org || undefined }) });
  });
}
