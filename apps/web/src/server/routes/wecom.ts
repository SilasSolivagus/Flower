import {
  AppError,
  applyWecomImport,
  completeWecomBind,
  getWecomApp,
  previewWecomImport,
  resolveActor,
  saveWecomApp,
  setMemberWecomUserid,
  startWecomBind,
  unbindMyWecom,
  type WecomOAuthDeps,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';
import { idParam } from './notifications';

const csvBody = z.object({ csv: z.string().max(200_000) });

const oauth = (deps: ApiDeps): WecomOAuthDeps => ({ secretKey: deps.notify.secretKey, publicUrl: deps.publicUrl, apiBase: deps.wecomApiBase });

export function registerWecomRoutes(app: App, deps: ApiDeps): void {
  // 成员的企业微信账号（组织管理员）
  app.put('/orgs/:org/members/:id/wecom', async (c) => {
    const memberId = idParam(c, 'id', '成员不存在');
    const body = await readJson(c, z.object({ userid: z.string().max(64).nullable() }));
    return c.json({ member: await setMemberWecomUserid(deps.db, c.get('actor'), memberId, body.userid) });
  });

  app.post('/orgs/:org/wecom-import/preview', async (c) => {
    const body = await readJson(c, csvBody);
    return c.json({ result: await previewWecomImport(deps.db, c.get('actor'), body.csv) });
  });

  app.post('/orgs/:org/wecom-import', async (c) => {
    const body = await readJson(c, csvBody);
    return c.json({ result: await applyWecomImport(deps.db, c.get('actor'), body.csv) });
  });

  // 企业微信自建应用（组织管理员）
  app.get('/orgs/:org/wecom-app', async (c) => c.json({ settings: await getWecomApp(deps.db, c.get('actor'), { publicUrl: deps.publicUrl }) }));

  app.put('/orgs/:org/wecom-app', async (c) => {
    const body = await readJson(c, z.object({ corpId: z.string().max(64), agentId: z.string().max(20), secret: z.string().max(200).optional(), bindEnabled: z.boolean() }));
    return c.json({ settings: await saveWecomApp(deps.db, c.get('actor'), body, { secretKey: deps.notify.secretKey, publicUrl: deps.publicUrl }) });
  });

  // 扫码绑定与解除（本人）
  app.post('/orgs/:org/me/wecom/bind', async (c) => c.json(await startWecomBind(deps.db, c.get('actor'), oauth(deps))));

  app.delete('/orgs/:org/me/wecom', async (c) => {
    await unbindMyWecom(deps.db, c.get('actor'));
    return c.body(null, 204);
  });
}

/**
 * 企业微信授权后浏览器跳回这里：结果以查询参数带回个人设置页（成功 wecom=bound，失败 wecom_error=原因）。
 * 这是浏览器跳转而不是接口调用，所以在组织解析中间件之前注册、自己解析操作者：路径里的组织必须是当前登录账号所属的组织
 * （actor.orgId 即该组织），否则同样跳回个人设置并显示中文原因，而不是返回 JSON 错误。
 */
export function registerWecomCallbackRoute(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/wecom/callback', async (c) => {
    const slug = c.req.param('org');
    const back = (q: Record<string, string>, withOrg = true) => c.redirect(`/settings?${new URLSearchParams({ ...(withOrg ? { org: slug } : {}), ...q })}`);
    const account = c.get('account');
    const actor = !c.get('tokenAuth') && account ? await resolveActor(deps.db, account.id, slug) : null;
    if (!actor) return back({ wecom_error: '请先登录，并使用该组织的成员账号完成绑定' }, false);
    try {
      await completeWecomBind(deps.db, actor, { code: c.req.query('code') ?? null, state: c.req.query('state') ?? null }, oauth(deps));
      return back({ wecom: 'bound' });
    } catch (e) {
      if (e instanceof AppError) return back({ wecom_error: e.message });
      throw e;
    }
  });
}
