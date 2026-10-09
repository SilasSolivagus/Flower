import type { AccountView, Actor, Db, FileStorage } from '@flower/core';
import { Hono } from 'hono';
import { authenticate, orgActor } from './auth-middleware';
import { errorHandler } from './http';
import { registerAuthRoutes } from './routes/auth';
import { registerInstanceRoutes } from './routes/instance';
import { registerSetupRoutes } from './routes/setup';
import { registerInvitationRoutes } from './routes/invitations';
import { registerMemberRoutes } from './routes/members';
import { registerOrgRoutes } from './routes/orgs';
import { registerProductRoutes } from './routes/products';
import { registerTokenRoutes } from './routes/tokens';
import { registerDefinitionRoutes } from './routes/definitions';
import { registerDocumentRoutes } from './routes/documents';
import { registerIterationRoutes } from './routes/iterations';
import { registerReleaseRoutes } from './routes/releases';
import { registerRequirementRoutes } from './routes/requirements';
import { registerReviewRoutes } from './routes/reviews';
import { registerStructureRoutes } from './routes/structure';
import { registerTaskRoutes } from './routes/tasks';
import { registerTemplateRoutes } from './routes/templates';
import { registerWorkbenchRoutes } from './routes/workbench';

export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string; storage: FileStorage };
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
  registerOrgRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerInvitationRoutes(app, deps);
  registerTokenRoutes(app, deps);
  registerProductRoutes(app, deps);
  registerDefinitionRoutes(app, deps);
  registerRequirementRoutes(app, deps);
  registerIterationRoutes(app, deps);
  registerReleaseRoutes(app, deps);
  registerStructureRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerReviewRoutes(app, deps);
  registerWorkbenchRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  registerTemplateRoutes(app, deps);
  return app;
}
