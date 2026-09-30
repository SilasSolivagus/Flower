import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInZone } from '../src/tasks/schedule';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createIteration, deleteIteration, type IterationView, setIterationStatus } from '../src/iterations/iterations';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { updateOrganization } from '../src/tenancy/orgs';
import { createTask, deleteTask, DEFAULT_TIMEZONE, orgToday, type TaskCreateInput, updateTask } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, regularIteration, seedInstance } from './factories';

const TODAY = '2026-09-30';
let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let readToken: Actor;
let pan: string;
let doc: string;
let sprint: IterationView;
let next: IterationView;
let finished: IterationView;
let special: IterationView;
let docSprint: IterationView;
let req: RequirementListItem;

const eventsOf = (subjectId: string, type: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type))));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  editor = await asMember(t.db, owner, '开发乙');
  viewer = await asMember(t.db, owner, '只读丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丁', 'guest');
  readToken = readOnlyToken(owner);
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  next = await createIteration(t.db, owner, regularIteration(pan, '迭代1012', '2026-10-12', '2026-10-23'));
  finished = await createIteration(t.db, owner, regularIteration(pan, '迭代0914', '2026-09-14', '2026-09-25'));
  await setIterationStatus(t.db, owner, finished.id, 'active');
  await setIterationStatus(t.db, owner, finished.id, 'done');
  special = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-09-01', endDate: '2026-12-31' });
  docSprint = await createIteration(t.db, owner, regularIteration(doc, '文档迭代', '2026-09-28', '2026-10-09'));
  req = await createRequirement(t.db, owner, pan, { title: '上传提速' });
});
afterAll(() => t.cleanup());

describe('新建任务', () => {
  it('挂需求的任务：产品取自需求，按今天推算进度，写 task.created 事件', async () => {
    const task = await createTask(
      t.db,
      editor,
      { requirementId: req.id, iterationId: sprint.id, title: '前端开发', assigneeMemberId: editor.memberId, planStart: '2026-09-28', planDays: 4 },
      { today: TODAY },
    );
    expect(task).toMatchObject({
      productId: pan,
      iterationId: sprint.id,
      requirement: { displayKey: 'PAN-1', title: '上传提速' },
      assignee: { displayName: '开发乙' },
      status: 'todo',
      planDays: 4,
      starred: false,
      flag: null,
      progressOverride: null,
      progress: 50,
      canEdit: true,
    });
    expect(await eventsOf(task.id, 'task.created')).toMatchObject([{ productId: pan, payload: { title: '前端开发', requirementId: req.id, iterationId: sprint.id } }]);
  });

  it('没有需求的任务：常规迭代取迭代的产品，专项必须指定产品，两者都没有时拒绝', async () => {
    expect((await createTask(t.db, editor, { iterationId: sprint.id, title: '联调' }, { today: TODAY })).productId).toBe(pan);
    await expect(createTask(t.db, owner, { iterationId: special.id, title: '专项设计' })).rejects.toMatchObject({ code: 'invalid', message: '专项里的任务需要指定所属产品' });
    expect((await createTask(t.db, owner, { iterationId: special.id, productId: doc, title: '专项设计' }, { today: TODAY })).productId).toBe(doc);
    await expect(createTask(t.db, owner, { title: '孤立任务' })).rejects.toMatchObject({ code: 'invalid', message: '任务需要属于一个迭代或一条需求' });
  });

  it('只能放进同产品、规划中或进行中的迭代', async () => {
    await expect(createTask(t.db, owner, { requirementId: req.id, iterationId: docSprint.id, title: '跨产品' })).rejects.toMatchObject({
      code: 'invalid',
      message: '不能把任务放进其他产品的迭代',
    });
    await expect(createTask(t.db, owner, { iterationId: finished.id, title: '补录' })).rejects.toMatchObject({ code: 'invalid', message: '只能在规划中或进行中的迭代里新建任务' });
  });

  it('字段校验：标题、工期以半天为单位、延期不能为负、进度 0–100、标记、日期', async () => {
    const bad = (input: Partial<TaskCreateInput>) => createTask(t.db, owner, { iterationId: sprint.id, title: '校验', ...input });
    await expect(bad({ title: ' ' })).rejects.toMatchObject({ code: 'invalid', message: '任务名称不能为空，且不超过 200 个字符' });
    await expect(bad({ planDays: 0 })).rejects.toMatchObject({ message: '工期以半天为单位，范围 0.5–365 天' });
    await expect(bad({ planDays: 1.3 })).rejects.toMatchObject({ message: '工期以半天为单位，范围 0.5–365 天' });
    await expect(bad({ delayDays: -0.5 })).rejects.toMatchObject({ message: '延期以半天为单位，范围 0–365 天' });
    await expect(bad({ progress: 101 })).rejects.toMatchObject({ message: '进度应为 0–100 的整数' });
    await expect(bad({ flag: 'bogus' as 'attention' })).rejects.toMatchObject({ message: '标记无效' });
    await expect(bad({ planStart: '2026-02-30' })).rejects.toMatchObject({ message: '开始日期格式应为 YYYY-MM-DD' });
    const half = await createTask(
      t.db,
      owner,
      { iterationId: sprint.id, title: '半天任务', planStart: '2026-09-28', planDays: 0.5, delayDays: 1.5, flag: 'attention' },
      { today: TODAY },
    );
    expect(half).toMatchObject({ planDays: 0.5, delayDays: 1.5, flag: 'attention', progress: 100 });
  });
});

describe('修改任务', () => {
  it('手动进度与说明存进 meta，事件带 changes；没有变化时不写事件；清空后按工期推算', async () => {
    const task = await createTask(t.db, editor, { iterationId: sprint.id, title: '埋点', planStart: '2026-09-28', planDays: 10 }, { today: TODAY });
    const v = await updateTask(t.db, editor, task.id, { progress: 30, note: '等接口', status: 'doing' }, { today: TODAY });
    expect(v).toMatchObject({ progressOverride: 30, progress: 30, note: '等接口', status: 'doing' });
    const [e] = await eventsOf(task.id, 'task.updated');
    expect(e!.payload.changes).toEqual([
      { field: 'status', old: 'todo', new: 'doing' },
      { field: 'note', old: null, new: '等接口' },
      { field: 'progress', old: null, new: 30 },
    ]);
    await updateTask(t.db, editor, task.id, { progress: 30 });
    expect(await eventsOf(task.id, 'task.updated')).toHaveLength(1);
    expect(await updateTask(t.db, editor, task.id, { progress: null, note: '' }, { today: TODAY })).toMatchObject({ progressOverride: null, note: null, progress: 20 });
    expect((await updateTask(t.db, editor, task.id, { status: 'done' }, { today: TODAY })).progress).toBe(100);
  });
});

describe('重点任务', () => {
  it('每个迭代最多 10 个；第 11 个返回冲突；其他迭代不受影响；取消后可以再标', async () => {
    const starred = [];
    for (let i = 1; i <= 10; i++) starred.push(await createTask(t.db, owner, { iterationId: next.id, title: `重点${i}`, starred: true }));
    await expect(createTask(t.db, owner, { iterationId: next.id, title: '重点11', starred: true })).rejects.toMatchObject({
      code: 'conflict',
      message: '每个迭代最多 10 个重点任务',
    });
    const plain = await createTask(t.db, owner, { iterationId: next.id, title: '普通任务' });
    await expect(updateTask(t.db, owner, plain.id, { starred: true })).rejects.toMatchObject({ code: 'conflict' });
    expect((await createTask(t.db, owner, { iterationId: sprint.id, title: '另一迭代的重点', starred: true })).starred).toBe(true);
    await updateTask(t.db, owner, starred[0]!.id, { starred: false });
    expect((await updateTask(t.db, owner, plain.id, { starred: true })).starred).toBe(true);
  });

  it('并发标为重点时不会超过上限', async () => {
    const it2 = await createIteration(t.db, owner, regularIteration(pan, '迭代1026', '2026-10-26', '2026-11-06'));
    for (let i = 1; i <= 8; i++) await createTask(t.db, owner, { iterationId: it2.id, title: `已标${i}`, starred: true });
    const candidates = [];
    for (let i = 1; i <= 3; i++) candidates.push(await createTask(t.db, owner, { iterationId: it2.id, title: `候选${i}` }));
    const results = await Promise.allSettled(candidates.map((c) => updateTask(t.db, owner, c.id, { starred: true })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['conflict']);
  });

  it('没有迭代的任务不能标为重点', async () => {
    await expect(createTask(t.db, owner, { requirementId: req.id, title: '需求子任务', starred: true })).rejects.toMatchObject({
      code: 'invalid',
      message: '只有迭代里的任务可以标为重点',
    });
  });
});

describe('权限', () => {
  it('只读成员与只读 Token 不能新建、修改、删除；看不到产品的访客得到 404，文案与更新、删除一致', async () => {
    const task = await createTask(t.db, owner, { iterationId: sprint.id, title: '权限测试' });
    for (const who of [viewer, readToken]) {
      await expect(createTask(t.db, who, { iterationId: sprint.id, title: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(updateTask(t.db, who, task.id, { title: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(deleteTask(t.db, who, task.id)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(createTask(t.db, guest, { iterationId: sprint.id, title: '越权' })).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
    await expect(updateTask(t.db, guest, task.id, { title: '越权' })).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
    await expect(deleteTask(t.db, guest, task.id)).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
  });
});

describe('删除', () => {
  it('删除任务并写事件；删除后再修改返回 404；迭代里还有任务时不能删除迭代', async () => {
    const empty = await createIteration(t.db, owner, regularIteration(pan, '迭代1109', '2026-11-09', '2026-11-20'));
    const task = await createTask(t.db, owner, { iterationId: empty.id, title: '临时任务' });
    await expect(deleteIteration(t.db, owner, empty.id)).rejects.toMatchObject({ code: 'invalid', message: '迭代中还有任务，请先删除' });
    await deleteTask(t.db, owner, task.id);
    expect(await eventsOf(task.id, 'task.deleted')).toMatchObject([{ productId: pan, payload: { title: '临时任务', iterationId: empty.id, requirementId: null } }]);
    await expect(updateTask(t.db, owner, task.id, { title: '已删除' })).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
    await deleteIteration(t.db, owner, empty.id);
  });
});

describe('组织时区', () => {
  it('时区无效时回退到默认时区', async () => {
    await updateOrganization(t.db, owner, { timezone: 'Not/AZone' });
    try {
      const today = await withOrg(t.db, owner.orgId, (tx) => orgToday(tx, owner.orgId));
      expect(today).toBe(todayInZone(DEFAULT_TIMEZONE));
    } finally {
      await updateOrganization(t.db, owner, { timezone: DEFAULT_TIMEZONE });
    }
  });
});
