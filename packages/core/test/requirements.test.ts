import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFieldOption, listFields } from '../src/definitions/fields';
import { domainEvents, stateTransitions, structureNodes } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { AppError } from '../src/errors';
import { listProductIterations, listStructureNodes } from '../src/requirements/lookups';
import { createRequirement, listRequirements, setRequirementField, updateRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let productId: string;
let requesterId: string;
let p0: string;
let p1: string;
let web: string;
let app: string;
let nodeId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  requesterId = (await createPlaceholderMember(t.db, owner, { displayName: '提出人甲' })).id;
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读乙' });
  await setProductRole(t.db, owner, productId, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  const fields = await listFields(t.db, owner);
  const priority = fields.find((f) => f.key === 'priority')!;
  p0 = priority.options.find((o) => o.key === 'p0')!.id;
  p1 = priority.options.find((o) => o.key === 'p1')!.id;
  const platform = fields.find((f) => f.key === 'platform')!;
  web = (await addFieldOption(t.db, owner, platform.id, { label: 'Web端', key: 'web' })).id;
  app = (await addFieldOption(t.db, owner, platform.id, { label: '移动端', key: 'mobile' })).id;
  const [node] = await withOrg(t.db, owner.orgId, (tx) =>
    tx.insert(structureNodes).values({ orgId: owner.orgId, productId, depth: 1, name: '会员与支付' }).returning({ id: structureNodes.id }),
  );
  nodeId = node!.id;
});
afterAll(() => t.cleanup());

describe('创建需求', () => {
  it('按产品顺序编号，初始状态取流程的初始状态，并记录流转与事件', async () => {
    const a = await createRequirement(t.db, owner, productId, {
      title: '支持批量下载',
      requesterMemberId: requesterId,
      fields: { priority: [p1], platform: [web, app] },
    });
    const b = await createRequirement(t.db, owner, productId, { title: '会员续费提醒', nodeId, fields: { priority: [p0] } });
    expect(a).toMatchObject({ number: 1, displayKey: 'PAN-1', stateKey: 'backlog', requester: { displayName: '提出人甲' } });
    expect(a.priority?.label).toBe('P1');
    expect(a.platforms.map((o) => o.label).sort()).toEqual(['Web端', '移动端']);
    expect(b).toMatchObject({ number: 2, node: { name: '会员与支付' } });
    const transitions = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(stateTransitions).where(eq(stateTransitions.requirementId, a.id)),
    );
    expect(transitions).toMatchObject([{ fromState: null, toState: 'backlog' }]);
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, a.id), eq(domainEvents.type, 'requirement.created'))),
    );
    expect(events).toHaveLength(1);
  });

  it('单选字段不能选两个值，选项必须属于该字段', async () => {
    await expect(createRequirement(t.db, owner, productId, { title: 'x', fields: { priority: [p0, p1] } })).rejects.toThrow(AppError);
    await expect(createRequirement(t.db, owner, productId, { title: 'x', fields: { priority: [web] } })).rejects.toThrow(AppError);
    await expect(createRequirement(t.db, owner, productId, { title: '   ' })).rejects.toThrow(AppError);
  });

  it('只读成员不能创建', async () => {
    await expect(createRequirement(t.db, viewer, productId, { title: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('需求列表', () => {
  it('支持按优先级、平台、业务域、提出人筛选，并给出各状态数量', async () => {
    const all = await listRequirements(t.db, viewer, productId);
    expect(all.total).toBe(2);
    expect(all.stateCounts).toEqual({ backlog: 2 });
    expect((await listRequirements(t.db, owner, productId, { priorityOptionIds: [p0] })).items.map((r) => r.title)).toEqual(['会员续费提醒']);
    expect((await listRequirements(t.db, owner, productId, { platformOptionIds: [web] })).items.map((r) => r.title)).toEqual(['支持批量下载']);
    expect((await listRequirements(t.db, owner, productId, { nodeIds: [nodeId] })).total).toBe(1);
    expect((await listRequirements(t.db, owner, productId, { requesterIds: [requesterId] })).total).toBe(1);
    expect((await listRequirements(t.db, owner, productId, { states: ['todo'] })).total).toBe(0);
    expect((await listRequirements(t.db, owner, productId, { states: ['todo'] })).stateCounts).toEqual({ backlog: 2 });
  });

  it('关键词可以匹配标题、编号或旧编号', async () => {
    expect((await listRequirements(t.db, owner, productId, { q: '批量' })).total).toBe(1);
    expect((await listRequirements(t.db, owner, productId, { q: 'PAN-2' })).items[0]?.title).toBe('会员续费提醒');
    expect((await listRequirements(t.db, owner, productId, { q: '2' })).items[0]?.number).toBe(2);
    expect((await listRequirements(t.db, owner, productId, { q: '100%' })).total).toBe(0);
  });

  it('分页与排序', async () => {
    const page1 = await listRequirements(t.db, owner, productId, { sort: 'number', pageSize: 1, page: 1 });
    const page2 = await listRequirements(t.db, owner, productId, { sort: 'number', pageSize: 1, page: 2 });
    expect([page1.items[0]?.number, page2.items[0]?.number]).toEqual([2, 1]);
    expect(page1.total).toBe(2);
  });
});

describe('修改需求', () => {
  it('修改标题与负责人并记录变更', async () => {
    const [r] = (await listRequirements(t.db, owner, productId, { q: 'PAN-1' })).items;
    const updated = await updateRequirement(t.db, owner, r!.id, { title: '支持批量下载与打包', ownerMemberId: requesterId });
    expect(updated).toMatchObject({ title: '支持批量下载与打包', owner: { displayName: '提出人甲' } });
    const [e] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, r!.id), eq(domainEvents.type, 'requirement.updated'))),
    );
    expect(e!.payload).toMatchObject({ changes: expect.arrayContaining([{ field: 'title', old: '支持批量下载', new: '支持批量下载与打包' }]) });
  });

  it('设置字段值会整体替换，并校验基数', async () => {
    const [r] = (await listRequirements(t.db, owner, productId, { q: 'PAN-1' })).items;
    expect((await setRequirementField(t.db, owner, r!.id, 'platform', [app])).map((o) => o.label)).toEqual(['移动端']);
    expect(await setRequirementField(t.db, owner, r!.id, 'platform', [])).toEqual([]);
    await expect(setRequirementField(t.db, owner, r!.id, 'priority', [p0, p1])).rejects.toThrow(AppError);
    await expect(setRequirementField(t.db, owner, r!.id, 'nope', [])).rejects.toMatchObject({ code: 'not_found' });
    await expect(setRequirementField(t.db, viewer, r!.id, 'platform', [web])).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('查询结构树节点与迭代', () => {
  it('列出本产品的节点和迭代', async () => {
    expect((await listStructureNodes(t.db, viewer, productId)).map((n) => n.name)).toEqual(['会员与支付']);
    expect(await listProductIterations(t.db, viewer, productId)).toEqual([]);
  });
});
