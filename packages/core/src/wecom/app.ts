import { eq } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { organizations, wecomApps } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { encryptConfig } from '../notifications/secrets';

export type WecomAppView = { corpId: string; agentId: string; secretHint: string; bindEnabled: boolean; updatedAt: Date };
export type WecomAppSettings = { app: WecomAppView | null; callbackUrl: string; callbackDomain: string };
export type WecomAppInput = { corpId: string; agentId: string; secret?: string; bindEnabled: boolean };
type AppRow = typeof wecomApps.$inferSelect;

/** 扫码回调地址：成员在企业微信授权后跳回这里。主机名要填到自建应用的「授权回调域」。 */
export const wecomCallbackUrl = (publicUrl: string, slug: string): string => `${publicUrl.replace(/\/+$/, '')}/api/v1/orgs/${slug}/wecom/callback`;
const secretHint = (secret: string): string => `****${secret.slice(-4)}`;
const view = (r: AppRow): WecomAppView => ({ corpId: r.corpId, agentId: r.agentId, secretHint: r.secretHint, bindEnabled: r.bindEnabled, updatedAt: r.updatedAt });

async function settingsTx(tx: Tx, orgId: string, publicUrl: string): Promise<WecomAppSettings> {
  const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new AppError('not_found', '组织不存在');
  const [row] = await tx.select().from(wecomApps).where(eq(wecomApps.orgId, orgId));
  const callbackUrl = wecomCallbackUrl(publicUrl, org.slug);
  return { app: row ? view(row) : null, callbackUrl, callbackDomain: new URL(callbackUrl).host };
}

export async function getWecomApp(db: Db, actor: Actor, deps: { publicUrl: string }): Promise<WecomAppSettings> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, (tx) => settingsTx(tx, actor.orgId, deps.publicUrl));
}

/** 保存企业微信自建应用：密钥留空表示不变（首次必填），加密存储，接口与事件只出现脱敏提示。 */
export async function saveWecomApp(db: Db, actor: Actor, input: WecomAppInput, deps: { secretKey: string; publicUrl: string }): Promise<WecomAppSettings> {
  requireOrgAdmin(actor);
  const corpId = input.corpId.trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(corpId)) throw new AppError('invalid', '企业 ID 格式不正确');
  const agentId = input.agentId.trim();
  if (!/^\d{1,20}$/.test(agentId)) throw new AppError('invalid', '应用 ID（AgentId）应为数字');
  const secret = input.secret?.trim() || null;
  if (secret && (secret.length > 200 || /\s/.test(secret))) throw new AppError('invalid', '应用密钥格式不正确');
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(wecomApps).where(eq(wecomApps.orgId, actor.orgId)).for('update');
    if (!cur && !secret) throw new AppError('invalid', '首次保存需要填写应用密钥');
    const next = {
      corpId,
      agentId,
      bindEnabled: input.bindEnabled,
      secret: secret ? encryptConfig({ secret }, deps.secretKey) : cur!.secret,
      secretHint: secret ? secretHint(secret) : cur!.secretHint,
      updatedAt: new Date(),
    };
    if (cur) await tx.update(wecomApps).set(next).where(eq(wecomApps.id, cur.id));
    else await tx.insert(wecomApps).values({ orgId: actor.orgId, ...next });
    const changes = (['corpId', 'agentId', 'bindEnabled', 'secretHint'] as const)
      .map((field) => ({ field, old: cur ? cur[field] : null, new: next[field] }))
      .filter((c) => c.old !== c.new);
    await recordEvent(tx, { orgId: actor.orgId, type: 'wecom_app.updated', subjectType: 'organization', subjectId: actor.orgId, actor, payload: { changes } });
    return settingsTx(tx, actor.orgId, deps.publicUrl);
  });
}
