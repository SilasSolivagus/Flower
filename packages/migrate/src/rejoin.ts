import { acceptInvitation, accounts, type Actor, createInvitation, type Db, listFunctionTags, listMembers, setMemberFunctionTags } from '@flower/core';
import { eq } from 'drizzle-orm';

export type RejoinEntry = { email: string; orgRole: 'admin' | 'member' | 'guest'; functionTags: string[] };

/**
 * `import --replace` 会删掉组织的全部成员关系，账号本身保留。这里让这些账号重新加入：
 * 以所有者身份发邀请，再以该账号接受（走正常的邀请流程与审计事件，不经过浏览器、不需要密码），最后恢复职能标签。
 * 先校验全部账号、职能标签与现有成员关系，任何账号或标签不存在就不写入任何数据；
 * 已经是活跃成员的账号跳过（不重复发邀请），在结果里标记为 skipped。
 */
export async function rejoinAccounts(
  db: Db,
  owner: Actor,
  entries: RejoinEntry[],
): Promise<Array<{ email: string; memberId: string; status: 'joined' | 'skipped' }>> {
  const tags = await listFunctionTags(db, owner);
  const activeMemberIdByEmail = new Map((await listMembers(db, owner)).filter((m) => m.status === 'active' && m.email).map((m) => [m.email!, m.id]));
  const plan: Array<{ email: string; orgRole: RejoinEntry['orgRole']; accountId: string; tagIds: string[]; skip: boolean }> = [];
  for (const e of entries) {
    const email = e.email.trim().toLowerCase();
    const [acc] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email));
    if (!acc) throw new Error(`找不到账号 ${email}`);
    const tagIds = e.functionTags.map((name) => {
      const tag = tags.find((x) => x.name === name);
      if (!tag) throw new Error(`组织里没有职能标签「${name}」`);
      return tag.id;
    });
    plan.push({ email, orgRole: e.orgRole, accountId: acc.id, tagIds, skip: activeMemberIdByEmail.has(email) });
  }
  const out: Array<{ email: string; memberId: string; status: 'joined' | 'skipped' }> = [];
  for (const p of plan) {
    if (p.skip) {
      out.push({ email: p.email, memberId: activeMemberIdByEmail.get(p.email)!, status: 'skipped' });
      continue;
    }
    const { token } = await createInvitation(db, owner, { email: p.email, orgRole: p.orgRole });
    const { memberId } = await acceptInvitation(db, token, { accountId: p.accountId });
    if (p.tagIds.length > 0) await setMemberFunctionTags(db, owner, memberId, p.tagIds);
    out.push({ email: p.email, memberId, status: 'joined' });
  }
  return out;
}
