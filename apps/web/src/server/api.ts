import type { AccountView, Actor, Db, FileStorage, NotifyDeps } from '@flower/core';
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
import { registerDashboardRoutes } from './routes/dashboard';
import { registerDefinitionRoutes } from './routes/definitions';
import { registerDocumentRoutes } from './routes/documents';
import { registerBriefRoutes } from './routes/briefs';
import { registerIterationRoutes } from './routes/iterations';
import { registerLinkRoutes } from './routes/links';
import { registerMemberNotificationRoutes } from './routes/member-notifications';
import { registerModuleDocRoutes } from './routes/module-docs';
import { registerNotificationRoutes } from './routes/notifications';
import { registerReleaseRoutes } from './routes/releases';
import { registerRequirementRoutes } from './routes/requirements';
import { registerReviewRoutes } from './routes/reviews';
import { registerStructureRoutes } from './routes/structure';
import { registerTaskRoutes } from './routes/tasks';
import { registerTemplateRoutes } from './routes/templates';
import { registerWecomCallbackRoute, registerWecomRoutes } from './routes/wecom';
import { registerWorkbenchRoutes } from './routes/workbench';
import { registerRequirementTagRoutes } from './routes/requirement-tags';
import { registerTrackingRoutes } from './routes/tracking';

/**
 * notify：推送的密钥、对外网址与发送器；tickApi：是否开放手动驱动后台发送的接口（FLOWER_NOTIFY_TICK_API=1）；
 * wecomApiBase：服务端访问企业微信接口的基础地址，生产固定为 https://qyapi.weixin.qq.com，只有测试传入本机假服务。
 */
export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string; storage: FileStorage; notify: NotifyDeps; tickApi: boolean; wecomApiBase: string };
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
  registerWecomCallbackRoute(app, deps);
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
  registerDashboardRoutes(app, deps);
  registerWorkbenchRoutes(app, deps);
  registerTrackingRoutes(app, deps);
  registerRequirementTagRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  registerBriefRoutes(app, deps);
  registerTemplateRoutes(app, deps);
  registerLinkRoutes(app, deps);
  registerModuleDocRoutes(app, deps);
  registerNotificationRoutes(app, deps);
  registerMemberNotificationRoutes(app, deps);
  registerWecomRoutes(app, deps);
  return app;
}
