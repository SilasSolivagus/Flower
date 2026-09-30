import {
  type Actor,
  type Db,
  getIterationGantt,
  getIterationScope,
  getRequirementByKey,
  getWorkbench,
  listIterations,
  listMemberTasks,
  listRequirementComments,
  listRequirements,
  listReviewQueue,
} from '@flower/core';

export type PerfCase = { name: string; run: () => Promise<unknown> };

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function measure(cases: PerfCase[], runs: number): Promise<Array<{ name: string; p50: number; p95: number; max: number }>> {
  const out: Array<{ name: string; p50: number; p95: number; max: number }> = [];
  for (const c of cases) {
    await c.run();
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await c.run();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const pick = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!;
    out.push({ name: c.name, p50: round1(pick(0.5)), p95: round1(pick(0.95)), max: round1(times.at(-1)!) });
  }
  return out;
}

export async function buildPerfCases(db: Db, actor: Actor, productId: string): Promise<PerfCase[]> {
  const sample = await listRequirements(db, actor, productId, { pageSize: 200 });
  const topState = Object.entries(sample.stateCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const ownerCount = new Map<string, number>();
  for (const r of sample.items) if (r.owner) ownerCount.set(r.owner.id, (ownerCount.get(r.owner.id) ?? 0) + 1);
  const topOwner = [...ownerCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const priorityId = sample.items.find((r) => r.priority)?.priority?.id;
  const keyword = sample.items.find((r) => r.title.length >= 2)?.title.slice(0, 2) ?? '需求';
  const keys = sample.items.slice(0, 20).map((r) => r.displayKey);
  const ids = sample.items.slice(0, 20).map((r) => r.id);
  let i = 0;
  let j = 0;
  const iterationList = await listIterations(db, actor);
  // 范围对比只对已开始的迭代有意义；取其中需求最多的一个
  const largest = iterationList.filter((it) => it.status !== 'planning').sort((a, b) => b.requirementCount - a.requirementCount)[0];
  // 甘特取任务最多的迭代；人员负载取任务最多的负责人
  let busiest: { id: string; count: number } | null = null;
  const assigneeCount = new Map<string, number>();
  for (const it of iterationList) {
    const g = await getIterationGantt(db, actor, it.id);
    if (!busiest || g.tasks.length > busiest.count) busiest = { id: it.id, count: g.tasks.length };
    for (const t of g.tasks) if (t.assignee) assigneeCount.set(t.assignee.id, (assigneeCount.get(t.assignee.id) ?? 0) + 1);
  }
  const topAssignee = [...assigneeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return [
    { name: '列表：默认第 1 页', run: () => listRequirements(db, actor, productId, {}) },
    { name: '列表：第 5 页', run: () => listRequirements(db, actor, productId, { page: 5 }) },
    { name: '列表：按最多的状态', run: () => listRequirements(db, actor, productId, { states: topState ? [topState] : [] }) },
    { name: '列表：按负责人', run: () => listRequirements(db, actor, productId, { ownerIds: topOwner ? [topOwner] : [] }) },
    { name: '列表：按优先级', run: () => listRequirements(db, actor, productId, { priorityOptionIds: priorityId ? [priorityId] : [] }) },
    { name: '列表：标题关键词', run: () => listRequirements(db, actor, productId, { q: keyword }) },
    { name: '列表：按编号', run: () => listRequirements(db, actor, productId, { q: keys[0] ?? '1' }) },
    { name: '详情：轮流打开', run: () => getRequirementByKey(db, actor, keys[i++ % Math.max(keys.length, 1)] ?? 'PAN-1') },
    { name: '评论：轮流读取', run: () => listRequirementComments(db, actor, ids[j++ % Math.max(ids.length, 1)]!) },
    { name: '迭代：列表', run: () => listIterations(db, actor) },
    { name: '迭代：范围对比（需求最多的迭代）', run: () => (largest ? getIterationScope(db, actor, largest.id) : Promise.resolve(null)) },
    { name: '甘特：任务最多的迭代', run: () => (busiest ? getIterationGantt(db, actor, busiest.id) : Promise.resolve(null)) },
    {
      name: '人员负载：任务最多的人（含已结束迭代）',
      run: () => (topAssignee ? listMemberTasks(db, actor, topAssignee, { includeFinished: true }) : Promise.resolve(null)),
    },
    { name: '评审队列：默认', run: () => listReviewQueue(db, actor, productId) },
    { name: '评审队列：等我签字', run: () => listReviewQueue(db, actor, productId, { waitingForMe: true }) },
    { name: '工作台', run: () => getWorkbench(db, actor.accountId!) },
  ];
}
