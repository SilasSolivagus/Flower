import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createBlocker, resolveBlocker } from '../src/requirements/blockers';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRelation, deleteRelation } from '../src/requirements/relations';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createOrganization, resolveActor } from '../src/tenancy/orgs';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guestEditor: Actor;
let readToken: Actor;
let a: RequirementListItem;
let b: RequirementListItem;
let d: RequirementListItem;
let foreignId: string;

const eventTypes = (subjectId: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select({ type: domainEvents.type, payload: domainEvents.payload }).from(domainEvents).where(eq(domainEvents.subjectId, subjectId)));

beforeAll(async () => {
  t = await createTestDb();
  const seeded = await seedInstance(t.db);
  owner = seeded.owner;
  const pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  const e = await createPlaceholderMember(t.db, owner, { displayName: '开发乙' });
  editor = { ...owner, memberId: e.id, orgRole: 'member', accountId: null };
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读丙' });
  await setProductRole(t.db, owner, pan, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  const g = await createPlaceholderMember(t.db, owner, { displayName: '外部编辑丁' });
  await setProductRole(t.db, owner, pan, g.id, 'editor');
  guestEditor = { ...owner, memberId: g.id, orgRole: 'guest', accountId: null };
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
  a = await createRequirement(t.db, owner, pan, { title: '上传断点续传' });
  b = await createRequirement(t.db, owner, pan, { title: '下载断点续传' });
  d = await createRequirement(t.db, owner, doc, { title: '文档导出' });
  const other = await createOrganization(t.db, seeded.account, { name: '其他组织', slug: 'other' });
  const otherOwner = (await resolveActor(t.db, seeded.account.id, other.org.slug))!;
  const otherProduct = (await createProduct(t.db, otherOwner, { name: '外部', key: 'EXT' })).id;
  foreignId = (await createRequirement(t.db, otherOwner, otherProduct, { title: '其他组织的需求' })).id;
});
afterAll(() => t.cleanup());

describe('阻塞项', () => {
  let blockerId: string;

  it('编辑可以新建阻塞项并指定负责人；详情中显示为未解除', async () => {
    const created = await createBlocker(t.db, editor, a.id, { description: ' 等待存储接口 ', ownerMemberId: editor.memberId });
    blockerId = created.id;
    expect(created).toMatchObject({ description: '等待存储接口', status: 'active', owner: { id: editor.memberId, displayName: '开发乙' }, resolvedAt: null });
    expect((await getRequirementByKey(t.db, owner, a.displayKey)).blockers).toMatchObject([{ id: created.id, status: 'active' }]);
    expect((await eventTypes(a.id)).map((e) => e.type)).toContain('blocker.created');
  });

  it('只读成员、只读 Token 不能新建或解除；描述不能为空', async () => {
    await expect(createBlocker(t.db, viewer, a.id, { description: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBlocker(t.db, readToken, a.id, { description: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveBlocker(t.db, viewer, blockerId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveBlocker(t.db, readToken, blockerId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBlocker(t.db, editor, a.id, { description: '   ' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('解除后记录解除时间；不能重复解除', async () => {
    const resolved = await resolveBlocker(t.db, editor, blockerId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    await expect(resolveBlocker(t.db, editor, blockerId)).rejects.toMatchObject({ code: 'invalid', message: '该阻塞项已解除' });
    const ev = (await eventTypes(a.id)).find((e) => e.type === 'blocker.resolved')!;
    expect(ev.payload).toMatchObject({ blockerId, changes: [{ field: 'status', old: 'active', new: 'resolved' }] });
  });
});

describe('需求关联', () => {
  let relationId: string;

  it('新建有方向的关联：两端详情分别显示 out 与 in，并带关联 id', async () => {
    relationId = (await createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'blocks' })).id;
    const fromSide = await getRequirementByKey(t.db, owner, a.displayKey);
    expect(fromSide.relations).toEqual([{ id: relationId, type: 'blocks', direction: 'out', other: { id: b.id, displayKey: b.displayKey, title: '下载断点续传' } }]);
    const toSide = await getRequirementByKey(t.db, owner, b.displayKey);
    expect(toSide.relations).toEqual([{ id: relationId, type: 'blocks', direction: 'in', other: { id: a.id, displayKey: a.displayKey, title: '上传断点续传' } }]);
    expect((await eventTypes(a.id)).find((e) => e.type === 'requirement.relation_added')!.payload).toMatchObject({ relationId, toId: b.id, type: 'blocks' });
  });

  it('不能关联自身；重复关联返回冲突；同一对需求不同类型可以并存；类型必须有效', async () => {
    await expect(createRelation(t.db, editor, { fromId: a.id, toId: a.id, type: 'related' })).rejects.toMatchObject({ code: 'invalid', message: '不能关联需求自身' });
    await expect(createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'blocks' })).rejects.toMatchObject({ code: 'conflict', message: '已存在相同的关联' });
    await createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'related' });
    await expect(createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'copy_of' as never })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('跨产品：能看到对方产品时可以关联；看不到时与不存在一样；跨组织的需求不存在', async () => {
    await createRelation(t.db, editor, { fromId: a.id, toId: d.id, type: 'merged_into' });
    expect((await getRequirementByKey(t.db, owner, d.displayKey)).relations).toMatchObject([{ type: 'merged_into', direction: 'in', other: { id: a.id } }]);
    await expect(createRelation(t.db, guestEditor, { fromId: b.id, toId: d.id, type: 'related' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createRelation(t.db, owner, { fromId: a.id, toId: foreignId, type: 'related' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('只读成员、只读 Token 不能新建或删除关联；编辑可以删除', async () => {
    await expect(createRelation(t.db, viewer, { fromId: b.id, toId: a.id, type: 'related' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createRelation(t.db, readToken, { fromId: b.id, toId: a.id, type: 'related' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteRelation(t.db, viewer, relationId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteRelation(t.db, readToken, relationId)).rejects.toMatchObject({ code: 'forbidden' });
    await deleteRelation(t.db, editor, relationId);
    expect((await getRequirementByKey(t.db, owner, b.displayKey)).relations.map((r) => r.type)).toEqual(['related']);
    await expect(deleteRelation(t.db, editor, relationId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await eventTypes(a.id)).map((e) => e.type)).toContain('requirement.relation_removed');
  });
});
