import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { createIteration, type IterationView, setIterationStatus } from '../src/iterations/iterations';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { getIterationGantt, listMemberTasks, listRequirementTasks } from '../src/tasks/queries';
import { createTask, updateTask } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

const TODAY = '2026-10-02';
let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let dev: Actor;
let panViewer: Actor;
let outsider: Actor;
let pan: string;
let doc: string;
let active: IterationView;
let planning: IterationView;
let closed: IterationView;
let special: IterationView;
let r1: RequirementListItem;
let r2: RequirementListItem;
let r3: RequirementListItem;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  dev = await asMember(t.db, owner, '开发乙');
  panViewer = await asMember(t.db, owner, '访客戊', 'guest');
  await setProductRole(t.db, owner, pan, panViewer.memberId, 'viewer');
  outsider = await asMember(t.db, owner, '访客己', 'guest');

  active = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  planning = await createIteration(t.db, owner, regularIteration(pan, '迭代1012', '2026-10-12', '2026-10-23'));
  closed = await createIteration(t.db, owner, regularIteration(pan, '迭代0914', '2026-09-14', '2026-09-25'));
  special = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-09-01', endDate: '2026-12-31' });
  r1 = await createRequirement(t.db, owner, pan, { title: '上传提速' });
  r2 = await createRequirement(t.db, owner, pan, { title: '分享统计' });
  r3 = await createRequirement(t.db, owner, doc, { title: '文档需求' });

  const a1 = await createTask(t.db, owner, { iterationId: active.id, requirementId: r1.id, title: '前端开发', assigneeMemberId: dev.memberId });
  await updateTask(t.db, owner, a1.id, { status: 'done' });
  await createTask(t.db, owner, { iterationId: active.id, requirementId: r1.id, title: '后端开发', assigneeMemberId: dev.memberId, planStart: '2026-10-01', planDays: 2, progress: 50 });
  await createTask(t.db, owner, { iterationId: active.id, requirementId: r2.id, title: '设计稿', flag: 'attention', progress: 20 });
  await createTask(t.db, owner, { iterationId: active.id, title: '联调', progress: 40, note: '等待接口' });
  await createTask(t.db, owner, { iterationId: planning.id, title: '预研', assigneeMemberId: dev.memberId, planStart: '2026-10-12' });
  await createTask(t.db, owner, { iterationId: closed.id, title: '旧任务', assigneeMemberId: dev.memberId });
  await createTask(t.db, owner, { requirementId: r2.id, title: '文档补充', assigneeMemberId: dev.memberId });
  await createTask(t.db, owner, { iterationId: special.id, productId: doc, title: '文档侧改造', assigneeMemberId: dev.memberId });
  await createTask(t.db, owner, { iterationId: special.id, productId: pan, title: '网盘侧改造', assigneeMemberId: dev.memberId });
  // 用于验证访客自查时仍按可见产品过滤
  await createTask(t.db, owner, { requirementId: r2.id, title: '网盘待办', assigneeMemberId: panViewer.memberId });
  await createTask(t.db, owner, { requirementId: r3.id, title: '文档待办', assigneeMemberId: panViewer.memberId });
  await setIterationStatus(t.db, owner, active.id, 'active');
  await setIterationStatus(t.db, owner, closed.id, 'active');
  await setIterationStatus(t.db, owner, closed.id, 'done');
});
afterAll(() => t.cleanup());

describe('甘特', () => {
  it('返回工作日、任务与概览：关注且未完成的需求不计入整体进度', async () => {
    const g = await getIterationGantt(t.db, owner, active.id, { today: TODAY });
    expect(g.iteration).toMatchObject({ id: active.id, name: '迭代0928', type: 'regular', product: { key: 'PAN' }, status: 'active' });
    expect(g.today).toBe(TODAY);
    expect(g.workdays).toHaveLength(10);
    expect(g.tasks.map((x) => x.title).sort()).toEqual(['前端开发', '后端开发', '联调', '设计稿'].sort());
    expect(g.overview).toEqual({
      rowCount: 3,
      countedCount: 2,
      overall: 58,
      expected: 44,
      behind: 0,
      deferred: 1,
      attention: [
        { kind: 'attention', title: 'PAN-2 分享统计', assignees: [], note: '' },
        { kind: 'notice', title: '联调', assignees: [], note: '等待接口' },
      ],
    });
    expect(g).toMatchObject({ starredCount: 0, canAddTask: true, editableProductIds: [pan] });
  });

  it('专项只列看得到的产品的任务；只读成员不能添加；已结束的迭代不能添加；看不到的迭代返回 404', async () => {
    const own = await getIterationGantt(t.db, owner, special.id, { today: TODAY });
    expect(own.tasks.map((x) => x.title).sort()).toEqual(['文档侧改造', '网盘侧改造'].sort());
    expect(own.editableProductIds.sort()).toEqual([pan, doc].sort());
    const viewerGantt = await getIterationGantt(t.db, panViewer, special.id, { today: TODAY });
    expect(viewerGantt.tasks.map((x) => x.title)).toEqual(['网盘侧改造']);
    expect(viewerGantt).toMatchObject({ canAddTask: false, editableProductIds: [] });
    expect((await getIterationGantt(t.db, owner, closed.id, { today: TODAY })).canAddTask).toBe(false);
    await expect(getIterationGantt(t.db, outsider, active.id)).rejects.toMatchObject({ code: 'not_found', message: '迭代不存在' });
  });
});

describe('按需求', () => {
  it('列出需求的全部任务；只读成员可以读；看不到产品返回 404', async () => {
    expect((await listRequirementTasks(t.db, panViewer, r1.id, { today: TODAY })).map((x) => x.title).sort()).toEqual(['前端开发', '后端开发'].sort());
    expect((await listRequirementTasks(t.db, owner, r2.id)).map((x) => x.title).sort()).toEqual(['文档补充', '设计稿', '网盘待办'].sort());
    await expect(listRequirementTasks(t.db, outsider, r1.id)).rejects.toMatchObject({ code: 'not_found', message: '需求不存在' });
  });
});

describe('按人跨迭代', () => {
  it('默认列出规划中与进行中迭代里的任务和不在迭代中的未完成任务，可以包含已结束的迭代', async () => {
    const open = await listMemberTasks(t.db, owner, dev.memberId, { today: TODAY });
    expect(open.member).toEqual({ id: dev.memberId, displayName: '开发乙' });
    expect(open.today).toBe(TODAY);
    expect(open.tasks.map((x) => x.title).sort()).toEqual(['前端开发', '后端开发', '预研', '文档补充', '文档侧改造', '网盘侧改造'].sort());
    expect(open.tasks.find((x) => x.title === '预研')!.iteration).toEqual({ id: planning.id, name: '迭代1012', startDate: '2026-10-12', endDate: '2026-10-23', status: 'planning' });
    expect(open.tasks.find((x) => x.title === '文档补充')!.iteration).toBeNull();
    const all = await listMemberTasks(t.db, owner, dev.memberId, { today: TODAY, includeFinished: true });
    expect(all.tasks.map((x) => x.title)).toContain('旧任务');
  });

  it('访客只能查询自己的任务，查询自己时仍按看得到的产品过滤；成员不存在返回 404', async () => {
    await expect(listMemberTasks(t.db, panViewer, dev.memberId, { today: TODAY })).rejects.toMatchObject({ code: 'forbidden' });
    const own = await listMemberTasks(t.db, panViewer, panViewer.memberId, { today: TODAY });
    expect(own.tasks.map((x) => x.title)).toContain('网盘待办');
    expect(own.tasks.map((x) => x.title)).not.toContain('文档待办');
    await expect(listMemberTasks(t.db, owner, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'not_found', message: '成员不存在' });
  });
});
