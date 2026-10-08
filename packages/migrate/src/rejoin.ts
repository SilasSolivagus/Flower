import { acceptInvitation, accounts, type Actor, createInvitation, type Db, listFunctionTags, listMembers, setMemberFunctionTags } from '@flower/core';
import { eq } from 'drizzle-orm';

export type RejoinEntry = { email: string; orgRole: 'admin' | 'member' | 'guest'; functionTags: string[] };

/**
 * `import --replace` 会删掉组织的全部成员关系，账号本身保留。这里让这些账号重新加入：
 * 以所有者身份发邀请，再以该账号接受（走正常的邀请流程与审计事件，不经过浏览器、不需要密码），最后恢复职能标签。
 * 先校验全部账号、职能标签与现有成员关系，任何账号或标签不存在就不写入任何数据；
 * 已经关联账号的活跃成员跳过（不重复发邀请），在结果里标记为 skipped；
 * 导入时按邮箱建好、但还没有关联账号的成员（旧数据里的本人，名下有需求、任务和签字记录），邀请时绑定到这个成员（bound），
 * 不另建一个没有历史记录的新成员。
 */
export async function rejoinAccounts(
  db: Db,
  owner: Actor,
  entries: RejoinEntry[],
): Promise<Array<{ email: string; memberId: string; status: 'joined' | 'bound' | 'skipped' }>> {
  const tags = await listFunctionTags(db, owner);
  const activeByEmail = new Map(
    (await listMembers(db, owner)).filter((m) => m.status === 'active' && m.kind === 'human' && m.email).map((m) => [m.email!.toLowerCase(), m]),
  );
  const plan: Array<{ email: string; orgRole: RejoinEntry['orgRole']; accountId: string; tagIds: string[]; existing: { id: string; hasAccount: boolean } | null }> = [];
  for (const e of entries) {
    const email = e.email.trim().toLowerCase();
    const [acc] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email));
    if (!acc) throw new Error(`找不到账号 ${email}`);
    const tagIds = e.functionTags.map((name) => {
      const tag = tags.find((x) => x.name === name);
      if (!tag) throw new Error(`组织里没有职能标签「${name}」`);
      return tag.id;
    });
    plan.push({ email, orgRole: e.orgRole, accountId: acc.id, tagIds, existing: activeByEmail.get(email) ?? null });
  }
  const out: Array<{ email: string; memberId: string; status: 'joined' | 'bound' | 'skipped' }> = [];
  for (const p of plan) {
    if (p.existing?.hasAccount) {
      out.push({ email: p.email, memberId: p.existing.id, status: 'skipped' });
      continue;
    }
    const bindTo = p.existing?.id;
    const { token } = await createInvitation(db, owner, { email: p.email, orgRole: p.orgRole, ...(bindTo ? { memberId: bindTo } : {}) });
    const { memberId } = await acceptInvitation(db, token, { accountId: p.accountId });
    if (p.tagIds.length > 0) await setMemberFunctionTags(db, owner, memberId, p.tagIds);
    out.push({ email: p.email, memberId, status: bindTo ? 'bound' : 'joined' });
  }
  return out;
}
