import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { addRequirementAssignment } from '../src/requirements/assignments';
import { createRequirement, listRequirements } from '../src/requirements/requirements';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let me: Actor;
let viewer: Actor;
let otherId: string;
let productId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  me = await asMember(t.db, owner, '我');
  const other = await asMember(t.db, owner, '其他人');
  otherId = other.memberId;
  viewer = await asMember(t.db, owner, '只读');
  await setProductRole(t.db, owner, productId, viewer.memberId, 'viewer');
  const tags = await listFunctionTags(t.db, owner);
  const design = tags.find((x) => x.name === '设计')!.id;
  const dev = tags.find((x) => x.name === '开发')!.id;

  await createRequirement(t.db, owner, productId, { title: '我负责', ownerMemberId: me.memberId, requesterMemberId: otherId });
  await createRequirement(t.db, owner, productId, { title: '我提出', ownerMemberId: otherId, requesterMemberId: me.memberId });
  const assigned = await createRequirement(t.db, owner, productId, { title: '我被分配', ownerMemberId: otherId, requesterMemberId: otherId });
  await addRequirementAssignment(t.db, owner, assigned.id, { memberId: me.memberId, functionTagId: design });
  await addRequirementAssignment(t.db, owner, assigned.id, { memberId: me.memberId, functionTagId: dev });
  await createRequirement(t.db, owner, productId, { title: '与我无关', ownerMemberId: otherId, requesterMemberId: otherId });
});
afterAll(() => t.cleanup());

describe('related=me', () => {
  it('命中负责人、提出人或被分配的人，同一需求多条分配只计一行', async () => {
    const list = await listRequirements(t.db, me, productId, { related: 'me', sort: 'number' });
    expect(list.items.map((r) => r.title)).toEqual(['我被分配', '我提出', '我负责']);
    expect(list.total).toBe(3);
    expect(list.stateCounts).toEqual({ backlog: 3 });
  });

  it('分页的 total 是 OR 之后的条数', async () => {
    const page1 = await listRequirements(t.db, me, productId, { related: 'me', sort: 'number', pageSize: 2, page: 1 });
    const page2 = await listRequirements(t.db, me, productId, { related: 'me', sort: 'number', pageSize: 2, page: 2 });
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
    expect(page1.items.map((r) => r.title)).toEqual(['我被分配', '我提出']);
    expect(page2.items.map((r) => r.title)).toEqual(['我负责']);
  });

  it('其它筛选与 related=me 取交集', async () => {
    const titled = await listRequirements(t.db, me, productId, { related: 'me', q: '提出' });
    expect(titled.total).toBe(1);
    expect(titled.items.map((r) => r.title)).toEqual(['我提出']);
    const none = await listRequirements(t.db, me, productId, { related: 'me', states: ['todo'] });
    expect(none.total).toBe(0);
    expect(none.stateCounts).toEqual({ backlog: 3 });
  });

  it('省略 related 仍返回产品内全部可读需求', async () => {
    const all = await listRequirements(t.db, me, productId, { sort: 'number' });
    expect(all.total).toBe(4);
    expect(all.items.map((r) => r.title)).toEqual(['与我无关', '我被分配', '我提出', '我负责']);
    const byOwner = await listRequirements(t.db, me, productId, { ownerIds: [me.memberId] });
    expect(byOwner.total).toBe(1);
    expect(byOwner.items[0]?.title).toBe('我负责');
    const asViewer = await listRequirements(t.db, viewer, productId, {});
    expect(asViewer.total).toBe(4);
    const viewerMine = await listRequirements(t.db, viewer, productId, { related: 'me' });
    expect(viewerMine.total).toBe(0);
    expect(viewerMine.items).toEqual([]);
  });

  it('related=me 与 owner 或 requester 同时传时拒绝', async () => {
    await expect(listRequirements(t.db, me, productId, { related: 'me', ownerIds: [otherId] })).rejects.toMatchObject({
      code: 'RELATED_CONFLICT',
      message: 'related=me 与 owner/requester 不能同时传',
    });
    await expect(listRequirements(t.db, me, productId, { related: 'me', requesterIds: [otherId] })).rejects.toMatchObject({
      code: 'RELATED_CONFLICT',
      message: 'related=me 与 owner/requester 不能同时传',
    });
    const empty = await listRequirements(t.db, me, productId, { related: 'me', ownerIds: [], requesterIds: [] });
    expect(empty.total).toBe(3);
  });

  it('related 只接受 me', async () => {
    await expect(listRequirements(t.db, me, productId, { related: 'foo' })).rejects.toMatchObject({
      code: 'INVALID_RELATED',
      message: 'related 只能是 me',
    });
    await expect(listRequirements(t.db, me, productId, { related: 'ME' })).rejects.toMatchObject({ code: 'INVALID_RELATED' });
  });
});
