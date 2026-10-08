import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkflowTemplate, publishWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { addRequirementAssignment } from '../src/requirements/assignments';
import { createBlocker } from '../src/requirements/blockers';
import { createRequirement, updateRequirement } from '../src/requirements/requirements';
import { createTask, updateTask } from '../src/tasks/tasks';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createAgentMember, createPlaceholderMember, updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { reviewWorkflow, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let active: string;
let left: string;
let agent: string;
let designTag: string;

const LEFT = { code: 'invalid', message: '该成员已离开组织，不能选择' };
const AGENT = { code: 'invalid', message: '不能选择 Agent 成员' };

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  active = (await createPlaceholderMember(t.db, owner, { displayName: '在职甲' })).id;
  left = (await createPlaceholderMember(t.db, owner, { displayName: '离职乙' })).id;
  await updateMember(t.db, owner, left, { status: 'left' });
  agent = (await createAgentMember(t.db, owner, { displayName: '同步机器人' })).id;
  designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
});
afterAll(() => t.cleanup());

describe('写入成员时必须是本组织在职的人类成员', () => {
  it('需求负责人与提出人：新建、修改时拒绝离职成员与 Agent', async () => {
    await expect(createRequirement(t.db, owner, pan, { title: '负责人离职', ownerMemberId: left })).rejects.toMatchObject(LEFT);
    await expect(createRequirement(t.db, owner, pan, { title: '提出人是 Agent', requesterMemberId: agent })).rejects.toMatchObject(AGENT);
    const r = await createRequirement(t.db, owner, pan, { title: '正常需求', ownerMemberId: active });
    await expect(updateRequirement(t.db, owner, r.id, { ownerMemberId: left })).rejects.toMatchObject(LEFT);
    await expect(updateRequirement(t.db, owner, r.id, { requesterMemberId: agent })).rejects.toMatchObject(AGENT);
  });

  it('不存在或其他组织的成员同样按 invalid 拒绝', async () => {
    await expect(
      createRequirement(t.db, owner, pan, { title: '查无此人', ownerMemberId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ code: 'invalid', message: '成员不存在或不属于本组织' });
  });

  it('负责人后来离职：修改与他无关的字段不受影响，保持原值也不报错', async () => {
    const who = (await createPlaceholderMember(t.db, owner, { displayName: '即将离职丙' })).id;
    const r = await createRequirement(t.db, owner, pan, { title: '旧负责人', ownerMemberId: who });
    await updateMember(t.db, owner, who, { status: 'left' });
    const updated = await updateRequirement(t.db, owner, r.id, { title: '改了标题', ownerMemberId: who });
    expect(updated).toMatchObject({ title: '改了标题', owner: { id: who } });
  });

  it('任务负责人：新建、修改时拒绝离职成员与 Agent', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '有任务的需求' });
    await expect(createTask(t.db, owner, { requirementId: req.id, title: '任务', assigneeMemberId: left })).rejects.toMatchObject(LEFT);
    await expect(createTask(t.db, owner, { requirementId: req.id, title: '任务', assigneeMemberId: agent })).rejects.toMatchObject(AGENT);
    const task = await createTask(t.db, owner, { requirementId: req.id, title: '任务', assigneeMemberId: active });
    await expect(updateTask(t.db, owner, task.id, { assigneeMemberId: left })).rejects.toMatchObject(LEFT);
    await expect(updateTask(t.db, owner, task.id, { assigneeMemberId: agent })).rejects.toMatchObject(AGENT);
  });

  it('需求分配与阻塞项负责人：拒绝离职成员与 Agent', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '分配与阻塞' });
    await expect(addRequirementAssignment(t.db, owner, req.id, { memberId: left, functionTagId: designTag })).rejects.toMatchObject(LEFT);
    await expect(addRequirementAssignment(t.db, owner, req.id, { memberId: agent, functionTagId: designTag })).rejects.toMatchObject(AGENT);
    await expect(createBlocker(t.db, owner, req.id, { description: '卡住了', ownerMemberId: left })).rejects.toMatchObject(LEFT);
    await expect(createBlocker(t.db, owner, req.id, { description: '卡住了', ownerMemberId: agent })).rejects.toMatchObject(AGENT);
  });

  it('会签「指定成员」：新建流程时拒绝离职成员与 Agent，错误里带检查项名称', async () => {
    await expect(createWorkflowTemplate(t.db, owner, { name: '离职签字人', body: reviewWorkflow(designTag, left) })).rejects.toMatchObject({
      code: 'invalid',
      message: '检查项「设计签字」的指定签字人：该成员已离开组织，不能选择',
    });
    await expect(createWorkflowTemplate(t.db, owner, { name: 'Agent 签字人', body: reviewWorkflow(designTag, agent) })).rejects.toMatchObject({
      code: 'invalid',
      message: '检查项「设计签字」的指定签字人：不能选择 Agent 成员',
    });
  });

  it('发布新版本时只校验新加入的指定成员：沿用已离职的签字人可以发布，换成另一个离职成员不行', async () => {
    const signer = (await createPlaceholderMember(t.db, owner, { displayName: '签字人丁' })).id;
    const { definition } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, signer) });
    await updateMember(t.db, owner, signer, { status: 'left' });
    await expect(publishWorkflowVersion(t.db, owner, definition.id, { body: reviewWorkflow(designTag, signer), note: '沿用' })).resolves.toMatchObject({
      version: 2,
    });
    await expect(publishWorkflowVersion(t.db, owner, definition.id, { body: reviewWorkflow(designTag, left) })).rejects.toMatchObject({
      code: 'invalid',
      message: '检查项「设计签字」的指定签字人：该成员已离开组织，不能选择',
    });
    await expect(publishWorkflowVersion(t.db, owner, definition.id, { body: reviewWorkflow(designTag, active) })).resolves.toMatchObject({ version: 3 });
  });
});
