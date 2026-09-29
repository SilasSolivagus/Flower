import { type Actor, type Db, getRequirementByKey, listRequirementComments, listRequirements } from '@flower/core';

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
  ];
}
