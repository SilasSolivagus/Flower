import { AppError, getInstanceStatus, runNotificationTick, updateInstanceSettings } from '@flower/core';
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

  /** 手动驱动一轮后台发送（端到端测试用）；只在 FLOWER_NOTIFY_TICK_API=1 时存在。 */
  app.post('/instance/notifications/tick', async (c) => {
    if (!deps.tickApi) throw new AppError('not_found', '接口不存在');
    if (!requireAccount(c).isInstanceAdmin) throw new AppError('forbidden', '需要实例管理员权限');
    const body = await readJson(c, z.object({ now: z.coerce.date().optional() }));
    return c.json({ summary: await runNotificationTick(deps.db, deps.notify, body.now) });
  });
}
