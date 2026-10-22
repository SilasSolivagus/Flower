/**
 * 批次 2 验收种子。只写组织 flower_uxseed。
 * 种：pnpm ux-seed:batch2
 * 清：pnpm ux-seed:batch2 -- --clean
 * 不要对 47.115.229.192、flower:local、flower_h5gate 执行。本机验收库若专为本批新建，清完后可以
 * docker compose -f docker-compose.dev.yml down -v
 */
import { eq } from 'drizzle-orm';
import { deleteOrgData } from '../packages/migrate/src/write.ts';
import { createDb } from '../packages/core/src/db/client.ts';
import { accounts, documents, memberNotifications, organizations, requirementTagLinks, requirementTags } from '../packages/core/src/db/schema.ts';
import { sql } from 'drizzle-orm';
import {
  createBlocker,
  createBrief,
  createDocument,
  createIteration,
  createOrganization,
  createPlaceholderMember,
  createProduct,
  createRequirement,
  createRequirementTag,
  createTask,
  createWorkItem,
  createWorkflowTemplate,
  initializeInstance,
  resolveActor,
  setCheckItemState,
  setProductRole,
  setProductWorkflowVersion,
  setRequirementIteration,
  setRequirementTags,
  setWorkItemStatus,
  transitionRequirement,
} from '@flower/core';

const SLUG = 'flower_uxseed';
const FORBIDDEN = '47.115.229.192';
const OWNER_EMAIL = 'uxseed@example.com';
const OWNER_PASSWORD = 'uxseed-pass-2026';

function assertHost(url: string): void {
  if (url.includes(FORBIDDEN)) throw new Error('拒绝连接 47.115.229.192');
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && process.env.FLOWER_UXSEED_ALLOW_HOST !== '1') {
    throw new Error(`只允许本机数据库，当前是 ${host}。确认不是 47.x / 共享库后可设 FLOWER_UXSEED_ALLOW_HOST=1`);
  }
}

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('缺少 DATABASE_ADMIN_URL');
assertHost(adminUrl);
if (process.env.DATABASE_URL) assertHost(process.env.DATABASE_URL);

const clean = process.argv.includes('--clean');
const { db, close } = createDb(adminUrl, { max: 1 });

const workflow = {
  states: [
    { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
    { key: 'doing', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
    { key: 'done', label: '已上线', color: '#10b981', order: 3, group: '', category: 'completed' },
  ],
  initial: 'backlog',
  transitions: [
    { from: '*', to: 'backlog', conditions: [] },
    { from: '*', to: 'doing', conditions: [] },
    { from: '*', to: 'done', conditions: [] },
  ],
  actionGates: [],
  checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' }],
};

try {
  const [existing] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, SLUG));
  if (existing && !clean) throw new Error(`组织 ${SLUG} 已存在。确认要删掉它再重种时加 --clean`);
  if (existing && clean) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from ${requirementTagLinks} where org_id = ${existing.id}`);
      await tx.execute(sql`delete from ${requirementTags} where org_id = ${existing.id}`);
      await deleteOrgData(tx, existing.id);
    });
    console.log(`已清除组织 ${SLUG}，接着重种`);
  }

  const [admin] = await db.select().from(accounts).where(eq(accounts.isInstanceAdmin, true)).limit(1);
  let accountEmail = admin?.email ?? OWNER_EMAIL;
  if (!admin) {
    const created = await initializeInstance(db, {
      admin: { email: OWNER_EMAIL, name: '验收管理员', password: OWNER_PASSWORD },
      org: { name: 'UX 验收', slug: SLUG },
    });
    accountEmail = created.account.email;
    console.log(`新建了实例管理员 ${OWNER_EMAIL}，密码 ${OWNER_PASSWORD}`);
  } else {
    await createOrganization(db, { id: admin.id, email: admin.email, name: admin.name, isInstanceAdmin: true, preferences: admin.preferences }, { name: 'UX 验收', slug: SLUG });
    console.log(`用已有实例管理员 ${admin.email} 创建了组织 ${SLUG}`);
  }

  const actor = await resolveActor(db, (await db.select().from(accounts).where(eq(accounts.email, accountEmail)))[0]!.id, SLUG);
  if (!actor) throw new Error('无法解析验收组织的所有者');

  const pan = await createProduct(db, actor, { name: '网盘', key: 'PAN' });
  const doc = await createProduct(db, actor, { name: '文档', key: 'DOC' });
  const wf = await createWorkflowTemplate(db, actor, { name: '验收流程', body: workflow });
  await setProductWorkflowVersion(db, actor, pan.id, wf.version.id);
  await setProductWorkflowVersion(db, actor, doc.id, wf.version.id);

  const reviewer = await createPlaceholderMember(db, actor, { displayName: '验收查看者' });
  await setProductRole(db, actor, pan.id, reviewer.id, 'viewer');

  const req = await createRequirement(db, actor, pan.id, { title: '评审中的需求', ownerMemberId: actor.memberId });
  await transitionRequirement(db, actor, req.id, { to: 'doing' });
  await setCheckItemState(db, actor, req.id, 'feasibility', { state: 'in_progress' });
  await createBlocker(db, actor, req.id, { description: '等设计确认' });
  const tag = await createRequirementTag(db, actor, { name: '体验', color: '#2563eb' });
  await setRequirementTags(db, actor, req.id, [tag.id]);

  const iteration = await createIteration(db, actor, { type: 'regular', productId: pan.id, name: '十月迭代', startDate: '2026-10-01', endDate: '2026-10-31' });
  await setRequirementIteration(db, actor, req.id, { iterationId: iteration.id });
  await createIteration(db, actor, { type: 'special', productId: null, name: '专项迭代', startDate: '2026-10-01', endDate: '2026-10-31' });
  const task = await createTask(db, actor, { title: '指派给查看者', productId: pan.id, iterationId: iteration.id, requirementId: req.id, assigneeMemberId: reviewer.id, status: 'doing' });

  const brief = await createBrief(db, actor, pan.id, { title: '有空白小节的简报', requirementIds: [req.id] });
  const doomed = await createDocument(db, actor, pan.id, { title: '已删除的通知文档' });
  await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, doomed.id));
  await db.insert(memberNotifications).values({
    orgId: actor.orgId,
    memberId: actor.memberId,
    kind: 'system_alert',
    subjectType: 'document',
    subjectId: doomed.id,
    title: `${doomed.displayKey} 已删除`,
    body: '文档已删除',
    url: `/${SLUG}/documents/${doomed.displayKey}`,
  });

  await createWorkItem(db, actor, { title: '进行中的工作项', productId: pan.id, ownerMemberId: actor.memberId });
  const done = await createWorkItem(db, actor, { title: '已完成的工作项', productId: doc.id, ownerMemberId: actor.memberId });
  await setWorkItemStatus(db, actor, done.id, 'done');
  const canceled = await createWorkItem(db, actor, { title: '已取消的工作项', productId: pan.id });
  await setWorkItemStatus(db, actor, canceled.id, 'canceled');

  console.log(`
种：组织 ${SLUG}
登录：${accountEmail}${admin ? '（沿用现有实例管理员密码）' : ` / ${OWNER_PASSWORD}`}
产品：网盘 PAN、文档 DOC
角色：所有者可写；占位成员「验收查看者」在网盘上是查看者（无账号，不能登录）
验：
- /${SLUG}/dashboard 切换网盘与文档
- /${SLUG}/reviews 能看到「${req.displayKey}」可行性进行中
- /${SLUG}/requirements/${req.displayKey} 有标签「体验」、阻塞「等设计确认」
- /${SLUG}/iterations/${iteration.id} 甘特里有「${task.displayKey}」
- /${SLUG}/iterations 产品筛选；选网盘时不应出现「专项迭代」
- /${SLUG}/work-items 默认只有进行中；?canceled=1 能看到已取消
- /${SLUG}/documents/${brief.displayKey} 失败检查有「去改」
- 通知里打开 /${SLUG}/documents/${doomed.displayKey} 应说明文档已删除，而不是无权访问
清：pnpm ux-seed:batch2 -- --clean
不要对 47.115.229.192、flower:local、flower_h5gate 做 down -v。
若这台库只为本次验收新建：docker compose -f docker-compose.dev.yml down -v
`);
} finally {
  await close();
}
