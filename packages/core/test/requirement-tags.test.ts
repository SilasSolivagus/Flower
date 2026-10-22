import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, requirementTagLinks, requirementTags } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirementTag, deleteRequirementTag, listRequirementTags, setRequirementTags, updateRequirementTag } from '../src/requirements/requirement-tags';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  viewer = await asMember(t.db, owner, '只读');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('需求标签', () => {
  it('字典增改查、重名、详情挂载与空数组、删除级联卸挂', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '要打标' });
    expect((await getRequirementByKey(t.db, owner, req.displayKey)).tags).toEqual([]);
    await expect(createRequirementTag(t.db, viewer, { name: '性能' })).rejects.toMatchObject({ code: 'forbidden' });
    const tag = await createRequirementTag(t.db, owner, { name: ' 性能 ' });
    expect(tag).toMatchObject({ name: '性能', color: '#64748b', usageCount: 0 });
    await expect(createRequirementTag(t.db, owner, { name: '性能' })).rejects.toMatchObject({ code: 'invalid', message: '已存在同名需求标签' });
    const renamed = await updateRequirementTag(t.db, owner, tag.id, { name: '体验', color: '#2563eb' });
    expect(renamed).toMatchObject({ name: '体验', color: '#2563eb' });
    const attached = await setRequirementTags(t.db, owner, req.id, [tag.id, tag.id]);
    expect(attached.map((x) => x.name)).toEqual(['体验']);
    expect((await listRequirementTags(t.db, viewer))[0]).toMatchObject({ name: '体验', usageCount: 1 });
    expect((await getRequirementByKey(t.db, viewer, req.displayKey)).tags.map((x) => x.id)).toEqual([tag.id]);
    await expect(setRequirementTags(t.db, viewer, req.id, [])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setRequirementTags(t.db, readOnlyToken(owner), req.id, [])).rejects.toMatchObject({ code: 'forbidden' });
    const removed = await deleteRequirementTag(t.db, owner, tag.id);
    expect(removed.removedFrom).toBe(1);
    expect(await listRequirementTags(t.db, owner)).toEqual([]);
    expect((await getRequirementByKey(t.db, owner, req.displayKey)).tags).toEqual([]);
  });

  it('跨组织标签挂不上，当成不存在', async () => {
    const otherOrg = newId();
    const otherTag = newId();
    await t.adminDb.insert(organizations).values({ id: otherOrg, slug: 'other', name: '别的组织' });
    await t.adminDb.insert(requirementTags).values({ id: otherTag, orgId: otherOrg, name: '外来', color: '#000000' });
    const req = await createRequirement(t.db, owner, pan, { title: '不挂外来标签' });
    await expect(setRequirementTags(t.db, owner, req.id, [otherTag])).rejects.toMatchObject({ code: 'not_found', message: '标签不存在' });
    expect(await withOrg(t.db, owner.orgId, (tx) => tx.select().from(requirementTagLinks).where(eq(requirementTagLinks.requirementId, req.id)))).toEqual([]);
  });

  it('行级安全挡住另一组织的读和写', async () => {
    const orgB = newId();
    const tagB = newId();
    await t.adminDb.insert(organizations).values({ id: orgB, slug: 'org-b', name: '乙' });
    await t.adminDb.insert(requirementTags).values({ id: tagB, orgId: orgB, name: '乙的标签', color: '#111111' });
    const seen = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(requirementTags).where(eq(requirementTags.id, tagB)));
    expect(seen).toEqual([]);
    await expect(
      withOrg(t.db, owner.orgId, (tx) => tx.insert(requirementTags).values({ orgId: orgB, name: '越权', color: '#222222' })),
    ).rejects.toThrow();
    await expect(
      withOrg(t.db, owner.orgId, (tx) =>
        tx.insert(requirementTagLinks).values({ orgId: orgB, requirementId: newId(), tagId: tagB }),
      ),
    ).rejects.toThrow();
  });
});
