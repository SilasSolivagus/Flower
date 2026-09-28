import type { AccountView, Actor, Db } from '@flower/core';
import { Hono } from 'hono';
import { authenticate, orgActor } from './auth-middleware';
import { errorHandler } from './http';
import { registerAuthRoutes } from './routes/auth';
import { registerInstanceRoutes } from './routes/instance';
import { registerSetupRoutes } from './routes/setup';

export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string };
export type ApiEnv = {
  Variables: {
    account: AccountView | null;
    tokenAuth: { actor: Actor; orgSlug: string } | null;
    actor: Actor;
  };
};
export type App = Hono<ApiEnv>;

export function createApi(deps: ApiDeps): App {
  const app = new Hono<ApiEnv>().basePath('/api/v1');
  app.onError(errorHandler);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: '接口不存在', details: null } }, 404));
  app.use('*', authenticate(deps));
  app.use('/orgs/:org', orgActor(deps));
  app.use('/orgs/:org/*', orgActor(deps));

  registerSetupRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerInstanceRoutes(app, deps);
  // Task 16：组织资源路由
  // Task 17：配置定义路由
  return app;
}
