import { AppError, getInstanceStatus, updateInstanceSettings } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';
import { readJson } from '../http';

export function registerInstanceRoutes(app: App, deps: ApiDeps): void {
  app.get('/instance/settings', async (c) => {
    if (!requireAccount(c).isInstanceAdmin) throw new AppError('forbidden', '需要实例管理员权限');
    return c.json(await getInstanceStatus(deps.db));
  });

  app.patch('/instance/settings', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(c, z.object({ allowSignup: z.boolean().optional(), allowOrgCreation: z.boolean().optional() }));
    return c.json(await updateInstanceSettings(deps.db, account, body));
  });
}
