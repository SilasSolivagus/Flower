import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkItemResults, checkItemSignoffs, entityAliases, requirementRelations, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { addRequirementComment, listRequirementComments } from '../src/requirements/comments';
import { createRequirement, listRequirements, updateRequirement } from '../src/requirements/requirements';
import { setCheckItemState, signCheckItem, transitionRequirement } from '../src/requirements/transitions';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createAgentMember, createPlaceholderMember, setMemberFunctionTags } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let boss: Actor;
let editor: Actor;
let reqId: string;
let workflowVersionId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  await setMemberFunctionTags(t.db, owner, owner.memberId, [designTag]);
  const bossMember = await createPlaceholderMember(t.db, owner, { displayName: '老板' });
  await setProductRole(t.db, owner, productId, bossMember.id, 'viewer');
  boss = { ...owner, memberId: bossMember.id, orgRole: 'member', accountId: null };
  const ed = await createPlaceholderMember(t.db, owner, { displayName: '编辑丙' });
  editor = { ...owner, memberId: ed.id, orgRole: 'member', accountId: null };
  const { version } = await createWorkflowTemplate(t.db, owner, {
    name: '评审流程',
    body: {
      states: [
        { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
        { key: 'todo', label: '待开发', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
        { key: 'doing', label: '开发中', color: '#f59e0b', order: 3, group: '', category: 'started' },
      ],
      initial: 'backlog',
      transitions: [
        { from: '*', to: 'todo', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed', 'not_needed'] }] },
        { from: '*', to: 'doing', conditions: [{ type: 'has_iteration' }] },
        { from: '*', to: 'backlog', conditions: [] },
      ],
      checkItems: [
        { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' },
        {
          key: 'design',
          label: '设计签字',
          scope: 'requirement',
          type: 'signoff',
          signers: [
            { by: 'function_tag', ref: designTag },
            { by: 'member', ref: bossMember.id },
          ],
          signoffRule: 'all',
        },
      ],
    },
  });
  await setProductWorkflowVersion(t.db, owner, productId, version.id);
  workflowVersionId = version.id;
  reqId = (await createRequirement(t.db, owner, productId, { title: '分享链接加密码' })).id;
  await withOrg(t.db, owner.orgId, (tx) =>
    tx.insert(entityAliases).values({ orgId: owner.orgId, entityType: 'requirement', entityId: reqId, alias: 'X20260312012' }),
  );
});
afterAll(() => t.cleanup());

describe('需求详情', () => {
  it('按编号或旧编号打开，给出可流转目标和卡住的原因', async () => {
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(d).toMatchObject({ displayKey: 'PAN-1', productKey: 'PAN', stateKey: 'backlog', myRole: 'admin', canForce: true, aliases: ['X20260312012'] });
    expect(d.transitions).toEqual([
      { to: 'todo', label: '待开发', allowed: false, unmet: [expect.objectContaining({ message: '「可行性」需为通过或不需要（当前：未开始）' })] },
      { to: 'doing', label: '开发中', allowed: false, unmet: [expect.objectContaining({ message: '需要先加入迭代' })] },
    ]);
    expect(d.checkItems.map((c) => [c.key, c.state])).toEqual([
      ['feasibility', 'not_started'],
      ['design', 'not_started'],
    ]);
    expect(d.checkItems[1]).toMatchObject({ canSign: [0], canSignOnBehalf: [1], signers: [{ label: '设计' }, { label: '老板' }] });
    expect(d.history).toMatchObject([{ from: null, to: 'backlog' }]);
    expect((await getRequirementByKey(t.db, owner, 'X20260312012')).id).toBe(reqId);
    await expect(getRequirementByKey(t.db, owner, 'PAN-99')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('状态流转', () => {
  it('条件不满足时拒绝，并返回原因', async () => {
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'todo' })).rejects.toMatchObject({
      code: 'invalid',
      details: { unmet: ['「可行性」需为通过或不需要（当前：未开始）'] },
    });
  });

  it('检查项满足后可以流转，历史记录新增一条', async () => {
    await setCheckItemState(t.db, owner, reqId, 'feasibility', { state: 'passed', note: '评估通过' });
    expect(await transitionRequirement(t.db, owner, reqId, { to: 'todo' })).toEqual({ stateKey: 'todo' });
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(d.history.map((h) => h.to)).toEqual(['backlog', 'todo']);
    expect(d.checkItems[0]).toMatchObject({ state: 'passed', note: '评估通过' });
  });

  it('强制流转仅产品管理员可用，且必须填写原因', async () => {
    await expect(transitionRequirement(t.db, boss, reqId, { to: 'doing', force: true, reason: '上线' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'doing', force: true, reason: ' ' })).rejects.toMatchObject({ code: 'invalid' });
    await transitionRequirement(t.db, owner, reqId, { to: 'doing', force: true, reason: '线上紧急修复' });
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(d.history.at(-1)).toMatchObject({ to: 'doing', forced: true, reason: '线上紧急修复' });
  });

  it('不能流转到当前状态或不存在的状态', async () => {
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'doing' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('检查项与会签', () => {
  it('会签检查项不能直接设置状态', async () => {
    await expect(setCheckItemState(t.db, owner, reqId, 'design', { state: 'passed' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('按签字规则逐一签字，全部通过后检查项通过', async () => {
    expect(await signCheckItem(t.db, owner, reqId, 'design', { decision: 'passed' })).toEqual({ state: 'in_progress' });
    await expect(signCheckItem(t.db, editor, reqId, 'design', { decision: 'passed' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await signCheckItem(t.db, boss, reqId, 'design', { decision: 'passed' })).toEqual({ state: 'passed' });
  });

  it('产品管理员可以代签"指定成员"规则，并记录实际操作人', async () => {
    expect(await signCheckItem(t.db, owner, reqId, 'design', { decision: 'rejected', ruleIndex: 1, onBehalf: true, note: '老板电话驳回' })).toEqual({
      state: 'rejected',
    });
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    const last = d.checkItems[1]!.signoffs.at(-1)!;
    expect(last).toMatchObject({ signer: { displayName: '老板' }, actedBy: { id: owner.memberId }, ruleIndex: 1, decision: 'rejected' });
    await expect(signCheckItem(t.db, owner, reqId, 'design', { decision: 'passed', ruleIndex: 0, onBehalf: true })).rejects.toMatchObject({ code: 'invalid' });
    await expect(signCheckItem(t.db, boss, reqId, 'design', { decision: 'passed', ruleIndex: 1, onBehalf: true })).rejects.toMatchObject({ code: 'forbidden' });
    const rows = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(checkItemSignoffs));
    expect(rows.filter((r) => r.actedByMemberId === owner.memberId)).toHaveLength(1);
  });

  it('流转后需求的更新时间和状态时间都会刷新', async () => {
    const [r] = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(requirements).where(and(eq(requirements.id, reqId))));
    expect(r!.stateChangedAt.getTime()).toBeGreaterThan(r!.createdAt.getTime());
  });
});

describe('Token 权限范围与访客', () => {
  it('只读 Token 不能签字，也不能流转', async () => {
    const readActor: Actor = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
    await expect(signCheckItem(t.db, readActor, reqId, 'design', { decision: 'passed' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(transitionRequirement(t.db, readActor, reqId, { to: 'backlog' })).rejects.toMatchObject({ code: 'forbidden' });
    const d = await getRequirementByKey(t.db, readActor, 'PAN-1');
    expect(d.checkItems[1]).toMatchObject({ canSign: [], canSignOnBehalf: [] });
  });

  it('限定产品的 Token 读写不到其他产品的需求', async () => {
    const productId = (await getRequirementByKey(t.db, owner, 'PAN-1')).productId;
    const otherProduct = (await createProduct(t.db, owner, { name: '相册', key: 'ALB' })).id;
    const scoped: Actor = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f2', tokenScope: { products: [otherProduct], access: 'write' } };
    const notFound = { code: 'not_found' };
    await expect(getRequirementByKey(t.db, scoped, 'PAN-1')).rejects.toMatchObject(notFound);
    await expect(listRequirements(t.db, scoped, productId)).rejects.toMatchObject(notFound);
    await expect(updateRequirement(t.db, scoped, reqId, { title: '越权修改' })).rejects.toMatchObject(notFound);
    await expect(transitionRequirement(t.db, scoped, reqId, { to: 'backlog', force: true, reason: '越权' })).rejects.toMatchObject(notFound);
    await expect(signCheckItem(t.db, scoped, reqId, 'design', { decision: 'passed' })).rejects.toMatchObject(notFound);
    await expect(listRequirementComments(t.db, scoped, reqId)).rejects.toMatchObject(notFound);
    await expect(addRequirementComment(t.db, scoped, reqId, { body: '越权评论' })).rejects.toMatchObject(notFound);
  });

  it('其他组织的成员拿到需求 ID 也读写不到', async () => {
    const outsider: Actor = { ...owner, orgId: '00000000-0000-0000-0000-00000000beef' };
    await expect(getRequirementByKey(t.db, outsider, 'PAN-1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateRequirement(t.db, outsider, reqId, { title: '跨组织修改' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(listRequirementComments(t.db, outsider, reqId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(addRequirementComment(t.db, outsider, reqId, { body: '跨组织评论' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('访客没有产品角色时，需求详情返回 not_found', async () => {
    const guestMember = await createAgentMember(t.db, owner, { displayName: '访客机器人', orgRole: 'guest' });
    const guest: Actor = { ...owner, memberId: guestMember.id, orgRole: 'guest', accountId: null, tokenId: null, tokenScope: null };
    await expect(getRequirementByKey(t.db, guest, 'PAN-1')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('跨产品关联', () => {
  it('关联需求按目标产品自身的编号展示，操作者对目标产品无权限时该关联被过滤', async () => {
    // 组织角色为 member 的成员默认在所有产品上有隐式 editor 权限（baseProductRole），
    // 因此本测试用一个显式只在 PAN 上被授予 viewer、组织角色为 guest（无隐式权限）的成员，
    // 验证它在 PAN2 上确实没有权限、该关联应被过滤。
    const productId = (await getRequirementByKey(t.db, owner, 'PAN-1')).productId;
    const viewerGuestMember = await createAgentMember(t.db, owner, { displayName: '只读访客', orgRole: 'guest' });
    await setProductRole(t.db, owner, productId, viewerGuestMember.id, 'viewer');
    const viewerGuest: Actor = { ...owner, memberId: viewerGuestMember.id, orgRole: 'guest', accountId: null, tokenId: null, tokenScope: null };

    const product2 = await createProduct(t.db, owner, { name: '网盘二', key: 'PAN2' });
    await setProductWorkflowVersion(t.db, owner, product2.id, workflowVersionId);
    const req2 = (await createRequirement(t.db, owner, product2.id, { title: '另一个产品的需求' })).id;
    await withOrg(t.db, owner.orgId, (tx) => tx.insert(requirementRelations).values({ orgId: owner.orgId, fromId: reqId, toId: req2, type: 'related' }));

    const asOwner = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(asOwner.relations).toContainEqual(expect.objectContaining({ type: 'related', direction: 'out', other: { id: req2, displayKey: 'PAN2-1', title: '另一个产品的需求' } }));

    const asViewerGuest = await getRequirementByKey(t.db, viewerGuest, 'PAN-1');
    expect(asViewerGuest.relations).toEqual([]);
  });
});

describe('会签并发与自签限制', () => {
  it('产品管理员不能代自己签字', async () => {
    const { version: selfVersion } = await createWorkflowTemplate(t.db, owner, {
      name: '自签测试流程',
      body: {
        states: [{ key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' }],
        initial: 'backlog',
        transitions: [],
        checkItems: [{ key: 'selfcheck', label: '自签检查', scope: 'requirement', type: 'signoff', signers: [{ by: 'member', ref: owner.memberId }], signoffRule: 'any' }],
      },
    });
    const product3 = await createProduct(t.db, owner, { name: '自签产品', key: 'SELF' });
    await setProductWorkflowVersion(t.db, owner, product3.id, selfVersion.id);
    const req3 = (await createRequirement(t.db, owner, product3.id, { title: '自签需求' })).id;

    await expect(signCheckItem(t.db, owner, req3, 'selfcheck', { decision: 'passed', ruleIndex: 0, onBehalf: true })).rejects.toMatchObject({ code: 'invalid' });

    const [r1, r2] = await Promise.all([
      signCheckItem(t.db, owner, req3, 'selfcheck', { decision: 'passed' }),
      signCheckItem(t.db, owner, req3, 'selfcheck', { decision: 'passed' }),
    ]);
    expect([r1.state, r2.state]).toEqual(['passed', 'passed']);
    const rows = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(checkItemResults).where(eq(checkItemResults.targetId, req3)));
    expect(rows).toHaveLength(1);
  });
});
