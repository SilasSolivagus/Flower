import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/accounts';
import { requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { addDocumentComment, markDocumentCommentsRead } from '../src/documents/comments';
import { createDocument } from '../src/documents/documents';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { addRequirementComment, markRequirementCommentsRead } from '../src/requirements/comments';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { createTask, updateTask } from '../src/tasks/tasks';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { acceptInvitation, createInvitation } from '../src/tenancy/invitations';
import { setMemberFunctionTags } from '../src/tenancy/members';
import { createOrganization, type OrgView, resolveActor } from '../src/tenancy/orgs';
import { createProduct } from '../src/tenancy/products';
import { getWorkbench } from '../src/workbench/workbench';
import { createTestDb } from './db';
import { asMember, readOnlyToken, regularIteration, reviewWorkflow, seedInstance } from './factories';

const TODAY = '2026-09-30';
let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let peerAccountId: string;
let other: OrgView;
let mine: RequirementListItem;

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  const pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  await setMemberFunctionTags(t.db, owner, owner.memberId, [designTag]);
  const boss = await asMember(t.db, owner, '老板乙');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  const { token } = await createInvitation(t.db, owner, { email: 'peer@example.com', orgRole: 'member' });
  peerAccountId = (await acceptInvitation(t.db, token, { newAccount: { name: '同事丁', password: 'password123' } })).accountId;
  const peer = (await resolveActor(t.db, peerAccountId, 'acme'))!;

  mine = await createRequirement(t.db, owner, pan, { title: '上传提速', ownerMemberId: owner.memberId }); // PAN-1
  const shipped = await createRequirement(t.db, owner, pan, { title: '已上线的需求', ownerMemberId: owner.memberId }); // PAN-2
  await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey: 'done' }).where(eq(requirements.id, shipped.id)));
  await createRequirement(t.db, owner, pan, { title: '同事负责的需求', ownerMemberId: peer.memberId }); // PAN-3
  await setCheckItemState(t.db, owner, mine.id, 'feasibility', { state: 'passed' });

  const sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  await createTask(t.db, owner, { iterationId: sprint.id, requirementId: mine.id, title: '接口联调', assigneeMemberId: owner.memberId, planStart: '2026-09-28', planDays: 4 });
  const done = await createTask(t.db, owner, { iterationId: sprint.id, title: '已完成的任务', assigneeMemberId: owner.memberId });
  await updateTask(t.db, owner, done.id, { status: 'done' });
  await setIterationStatus(t.db, owner, sprint.id, 'active');
  const dropped = await createIteration(t.db, owner, regularIteration(pan, '迭代1012', '2026-10-12', '2026-10-23'));
  await createTask(t.db, owner, { iterationId: dropped.id, title: '取消迭代里的任务', assigneeMemberId: owner.memberId });
  await setIterationStatus(t.db, owner, dropped.id, 'canceled');
  await createTask(t.db, peer, { iterationId: sprint.id, title: '同事的任务', assigneeMemberId: peer.memberId });

  await addRequirementComment(t.db, peer, mine.id, { body: '接口文档在哪？' });
  await addRequirementComment(t.db, peer, mine.id, { body: '补充：需要鉴权吗？' });
  await addRequirementComment(t.db, owner, mine.id, { body: '稍后补上' });

  ({ org: other } = await createOrganization(t.db, account, { name: '第二组织', slug: 'other' }));
  const otherActor = (await resolveActor(t.db, account.id, 'other'))!;
  const docProduct = (await createProduct(t.db, otherActor, { name: '文档', key: 'DOC' })).id;
  await createRequirement(t.db, otherActor, docProduct, { title: '另一个组织的需求', ownerMemberId: otherActor.memberId });
});
afterAll(() => t.cleanup());

describe('工作台', () => {
  it('汇总本人在所有组织里负责的未完成需求，其他组织的行带组织信息', async () => {
    const wb = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(wb.orgs.map((o) => o.slug)).toEqual(['acme', 'other']);
    expect(wb.owned.total).toBe(2);
    expect(wb.owned.items.map((r) => `${r.org.slug}:${r.displayKey}`).sort()).toEqual(['acme:PAN-1', 'other:DOC-1']);
    expect(wb.owned.items.find((r) => r.displayKey === 'DOC-1')!.org).toEqual({ id: other.id, slug: 'other', name: '第二组织' });
    expect(wb.owned.items.find((r) => r.displayKey === 'PAN-1')!.state).toMatchObject({ label: '收集' });
  });

  it('指派给我的未完成任务，排除已完成的任务和已取消迭代里的任务', async () => {
    const wb = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(wb.tasks).toEqual({
      total: 1,
      items: [
        {
          org: { id: owner.orgId, slug: 'acme', name: '测试组织' },
          id: expect.any(String),
          displayKey: 'PAN-T-1',
          title: '接口联调',
          requirement: { displayKey: 'PAN-1', title: '上传提速' },
          iteration: { id: expect.any(String), name: '迭代0928' },
          status: 'todo',
          planStart: '2026-09-28',
          progress: 50,
        },
      ],
    });
  });

  it('等我签字包括本人的规则和可以代签的规则', async () => {
    const wb = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(wb.signatures.items).toMatchObject([
      { displayKey: 'PAN-1', itemKey: 'design', itemLabel: '设计签字', ruleIndex: 0, onBehalfOf: null },
      { displayKey: 'PAN-1', itemKey: 'design', itemLabel: '设计签字', ruleIndex: 1, onBehalfOf: '老板乙' },
    ]);
  });

  it('我负责的需求上别人发的未读评论按需求合计；标记已读后消失', async () => {
    const before = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(before.unread.items).toMatchObject([{ displayKey: 'PAN-1', unread: 2 }]);
    await markRequirementCommentsRead(t.db, owner, mine.id);
    expect((await getWorkbench(t.db, account.id, { today: TODAY })).unread.total).toBe(0);
  });

  it('跨组织隔离：只属于一个组织的账号看不到其他组织的任何内容', async () => {
    const wb = await getWorkbench(t.db, peerAccountId, { today: TODAY });
    expect(wb.orgs.map((o) => o.slug)).toEqual(['acme']);
    expect(wb.owned.items.map((r) => r.displayKey)).toEqual(['PAN-3']);
    expect(wb.tasks.items.map((x) => x.title)).toEqual(['同事的任务']);
    expect(wb.signatures.total).toBe(0);
    // 同事在 PAN-1 上评论过，之后负责人回复的一条对同事是未读
    expect(wb.unread.items.map((u) => [u.displayKey, u.unread])).toEqual([['PAN-1', 1]]);
    const all = [...wb.owned.items, ...wb.tasks.items, ...wb.signatures.items, ...wb.unread.items];
    expect(all.every((x) => x.org.slug === 'acme')).toBe(true);
  });

  it('需求的未读评论也包括我评论过、不由我负责的需求；只有别人评论过的不计入', async () => {
    const peer = (await resolveActor(t.db, peerAccountId, 'acme'))!;
    const joined = await createRequirement(t.db, peer, mine.productId, { title: '我评论过的需求', ownerMemberId: peer.memberId });
    const unrelated = await createRequirement(t.db, peer, mine.productId, { title: '与我无关的需求', ownerMemberId: peer.memberId });
    await addRequirementComment(t.db, owner, joined.id, { body: '这里要确认一下' });
    await addRequirementComment(t.db, peer, joined.id, { body: '已确认' });
    await addRequirementComment(t.db, peer, unrelated.id, { body: '与我无关' });

    const before = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(before.unread.items.map((u) => [u.displayKey, u.title, u.unread, u.documentId])).toEqual([[joined.displayKey, '我评论过的需求', 1, null]]);
    await markRequirementCommentsRead(t.db, owner, joined.id);
    expect((await getWorkbench(t.db, account.id, { today: TODAY })).unread.total).toBe(0);
  });

  it('PRD 的未读评论：我负责的或我评论过的 PRD 上别人发的；标记已读后消失；需求行不受影响', async () => {
    const peer = (await resolveActor(t.db, peerAccountId, 'acme'))!;
    const owned = await createDocument(t.db, owner, mine.productId, { title: '我负责的 PRD', ownerMemberId: owner.memberId });
    const joined = await createDocument(t.db, peer, mine.productId, { title: '我评论过的 PRD', ownerMemberId: peer.memberId });
    const unrelated = await createDocument(t.db, peer, mine.productId, { title: '无关的 PRD', ownerMemberId: peer.memberId });
    await addDocumentComment(t.db, peer, owned.id, { body: '负责人看一下' });
    await addDocumentComment(t.db, owner, joined.id, { body: '我先提一个问题' });
    await addDocumentComment(t.db, peer, joined.id, { body: '已回答' });
    await addDocumentComment(t.db, peer, unrelated.id, { body: '与我无关' });

    const before = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(before.unread.items.filter((u) => u.documentId).map((u) => [u.displayKey, u.title, u.unread, u.requirementId]).sort()).toEqual([
      [owned.displayKey, '我负责的 PRD', 1, null],
      [joined.displayKey, '我评论过的 PRD', 1, null],
    ]);
    expect(before.unread.items.filter((u) => u.requirementId).every((u) => u.documentId === null)).toBe(true);

    await expect(markDocumentCommentsRead(t.db, readOnlyToken(owner), owned.id)).rejects.toMatchObject({ code: 'forbidden', message: '只读 Token 不能标记已读' });
    expect(await markDocumentCommentsRead(t.db, owner, owned.id)).toBe(1);
    expect(await markDocumentCommentsRead(t.db, owner, joined.id)).toBe(1);
    expect((await getWorkbench(t.db, account.id, { today: TODAY })).unread.items.filter((u) => u.documentId)).toEqual([]);
  });
});
