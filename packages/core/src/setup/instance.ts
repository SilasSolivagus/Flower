import { eq, sql } from 'drizzle-orm';
import { type AccountView, createAccount } from '../auth/accounts';
import type { Db } from '../db/client';
import { instanceSettings } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError } from '../errors';
import { createOrgInTx, type OrgView } from '../tenancy/orgs';

export type InstanceStatus = { initialized: boolean; allowSignup: boolean; allowOrgCreation: boolean };

const SETUP_LOCK = 4_242_001;

async function readStatus(q: Queryable): Promise<InstanceStatus> {
  const [row] = await q.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
  return {
    initialized: Boolean(row?.initializedAt),
    allowSignup: row?.allowSignup ?? false,
    allowOrgCreation: row?.allowOrgCreation ?? false,
  };
}

export const getInstanceStatus = (db: Db): Promise<InstanceStatus> => readStatus(db);

export async function initializeInstance(
  db: Db,
  input: { admin: { email: string; name: string; password: string }; org: { name: string; slug: string } },
): Promise<{ account: AccountView; org: OrgView; memberId: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    if ((await readStatus(tx)).initialized) throw new AppError('already_initialized', '实例已完成初始化');
    await tx
      .insert(instanceSettings)
      .values({ id: 1, initializedAt: new Date() })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { initializedAt: new Date(), updatedAt: new Date() } });
    const account = await createAccount(tx, { ...input.admin, isInstanceAdmin: true });
    const { org, memberId } = await createOrgInTx(tx, account, input.org);
    return { account, org, memberId };
  });
}

export async function updateInstanceSettings(
  db: Db,
  account: AccountView,
  patch: { allowSignup?: boolean; allowOrgCreation?: boolean },
): Promise<InstanceStatus> {
  if (!account.isInstanceAdmin) throw new AppError('forbidden', '需要实例管理员权限');
  await db
    .update(instanceSettings)
    .set({
      ...(patch.allowSignup === undefined ? {} : { allowSignup: patch.allowSignup }),
      ...(patch.allowOrgCreation === undefined ? {} : { allowOrgCreation: patch.allowOrgCreation }),
      updatedAt: new Date(),
    })
    .where(eq(instanceSettings.id, 1));
  return readStatus(db);
}

export async function signUp(db: Db, input: { email: string; name: string; password: string }): Promise<AccountView> {
  const status = await readStatus(db);
  if (!status.initialized || !status.allowSignup) throw new AppError('forbidden', '当前实例仅支持邀请加入');
  return createAccount(db, input);
}
