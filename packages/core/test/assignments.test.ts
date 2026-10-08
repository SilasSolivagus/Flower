import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addFieldOption, listFields, updateFieldOption } from '../src/definitions/fields';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { addRequirementAssignment, removeRequirementAssignment } from '../src/requirements/assignments';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { listReviewQueue } from '../src/reviews/queue';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createPlaceholderMember, setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createOrganization, resolveActor } from '../src/tenancy/orgs';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, reviewWorkflow, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let designerA: Actor;
let designerB: Actor;
let viewer: Actor;
let pan: string;
let designTag: string;
let pc: string;
let priorityOption: string;
let otherOrgTag: string;
let reqId: string;

const eventsOf = (subjectId: string, type: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type))));

beforeAll(async () => {
  t = await createTestDb();
  const seeded = await seedInstance(t.db);
  owner = seeded.owner;
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  designerA = await asMember(t.db, owner, '设计师甲');
  designerB = await asMember(t.db, owner, '设计师乙');
  await setMemberFunctionTags(t.db, owner, designerA.memberId, [designTag]);
  await setMemberFunctionTags(t.db, owner, designerB.memberId, [designTag]);
  const boss = await asMember(t.db, owner, '老板丙');
  viewer = await asMember(t.db, owner, '只读丁');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  const fields = await listFields(t.db, owner);
  pc = (await addFieldOption(t.db, owner, fields.find((f) => f.key === 'platform')!.id, { label: 'PC客户端' })).id;
  priorityOption = fields.find((f) => f.key === 'priority')!.options[0]!.id;
  await createOrganization(t.db, seeded.account, { name: '第二组织', slug: 'other' });
  const otherActor = (await resolveActor(t.db, seeded.account.id, 'other'))!;
  otherOrgTag = (await listFunctionTags(t.db, otherActor))[0]!.id;
  reqId = (await createRequirement(t.db, owner, pan, { title: '上传提速' })).id;
});
afterAll(() => t.cleanup());

describe('需求分配', () => {
  it('编辑者新增分配并写事件；需求详情带分配 id；完全相同的分配返回冲突，平台不同不算重复', async () => {
    const a = await addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag });
    const [e] = await eventsOf(reqId, 'requirement.assignment_added');
    expect(e!.payload).toMatchObject({
      assignmentId: a.id,
      changes: [{ field: 'assignments', old: null, new: { memberId: designerA.memberId, functionTagId: designTag, platformOptionId: null } }],
    });
    await expect(addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag })).rejects.toMatchObject({
      code: 'conflict',
      message: '已经有相同的分配',
    });
    await addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag, platformOptionId: pc });
    await expect(
      addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag, platformOptionId: pc }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const detail = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(detail.assignments).toContainEqual({ id: a.id, member: { id: designerA.memberId, displayName: '设计师甲' }, functionTag: { id: designTag, name: '设计' }, platform: null });
  });

  it('校验：离职成员、其他组织的职能标签、不属于「平台」字段的选项', async () => {
    const left = await createPlaceholderMember(t.db, owner, { displayName: '离职戊' });
    await updateMember(t.db, owner, left.id, { status: 'left' });
    await expect(addRequirementAssignment(t.db, owner, reqId, { memberId: left.id, functionTagId: designTag })).rejects.toMatchObject({
      code: 'invalid',
      message: '该成员已离开组织，不能选择',
    });
    await expect(addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: otherOrgTag })).rejects.toMatchObject({
      code: 'invalid',
      message: '职能标签不存在',
    });
    await expect(
      addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: priorityOption }),
    ).rejects.toMatchObject({ code: 'invalid', message: '平台选项不属于本产品的「平台」字段' });
  });

  it('校验：已停用的平台选项不能用于新分配（复用 releases 的平台校验）', async () => {
    await updateFieldOption(t.db, owner, pc, { active: false });
    await expect(
      addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: pc }),
    ).rejects.toMatchObject({ code: 'invalid', message: '选项「PC客户端」已停用' });
    await updateFieldOption(t.db, owner, pc, { active: true });
  });

  it('只读成员与只读 Token 不能新增或删除；看不到产品的访客得到 404', async () => {
    const a = await addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: designTag });
    for (const who of [viewer, readOnlyToken(owner)]) {
      await expect(addRequirementAssignment(t.db, who, reqId, { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: pc })).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(removeRequirementAssignment(t.db, who, a.id)).rejects.toMatchObject({ code: 'forbidden' });
    }
    const guest = await asMember(t.db, owner, '访客己', 'guest');
    await expect(removeRequirementAssignment(t.db, guest, a.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('删除分配并写事件；再次删除返回 404', async () => {
    const a = await addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: pc });
    await removeRequirementAssignment(t.db, owner, a.id);
    const removed = (await eventsOf(reqId, 'requirement.assignment_removed')).find((x) => x.payload.assignmentId === a.id);
    expect(removed!.payload.changes).toEqual([
      { field: 'assignments', old: { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: pc }, new: null },
    ]);
    await expect(removeRequirementAssignment(t.db, owner, a.id)).rejects.toMatchObject({ code: 'not_found', message: '分配不存在' });
  });

  it('分配设计后，「等我签字」只推给被分配的设计；删除分配后回到推给全部设计', async () => {
    const r = (await createRequirement(t.db, owner, pan, { title: '分享统计' })).id; // PAN-2
    await setCheckItemState(t.db, owner, r, 'feasibility', { state: 'passed' });
    const waiting = async (who: Actor) => (await listReviewQueue(t.db, who, pan, { waitingForMe: true })).rows.map((x) => x.displayKey);
    expect(await waiting(designerA)).toContain('PAN-2');
    expect(await waiting(designerB)).toContain('PAN-2');
    const a = await addRequirementAssignment(t.db, owner, r, { memberId: designerA.memberId, functionTagId: designTag });
    expect(await waiting(designerA)).toContain('PAN-2');
    expect(await waiting(designerB)).not.toContain('PAN-2');
    await removeRequirementAssignment(t.db, owner, a.id);
    expect(await waiting(designerB)).toContain('PAN-2');
  });
});
