import type { Iteration, IterationMilestone } from '@/lib/types';

export type IterationGroup = { key: string; title: string; iterations: Iteration[] };

/** 按产品分组（产品按编号前缀排序），专项放最后；组内保持接口顺序（开始日期倒序）。 */
export function groupIterations(list: Iteration[]): IterationGroup[] {
  const groups = new Map<string, IterationGroup & { sortKey: string }>();
  for (const it of list) {
    const key = it.product?.id ?? 'special';
    if (!groups.has(key)) groups.set(key, { key, title: it.product?.name ?? '专项', iterations: [], sortKey: it.product?.key ?? '' });
    groups.get(key)!.iterations.push(it);
  }
  return [...groups.values()]
    .sort((a, b) => (a.key === 'special' ? 1 : b.key === 'special' ? -1 : a.sortKey.localeCompare(b.sortKey)))
    .map(({ key, title, iterations }) => ({ key, title, iterations }));
}

export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function milestoneTimeline(milestones: IterationMilestone[], today: string): Array<IterationMilestone & { past: boolean }> {
  return [...milestones].sort((a, b) => a.date.localeCompare(b.date)).map((m) => ({ ...m, past: m.date < today }));
}

export type IterationForm = { name: string; startDate: string; endDate: string; milestones: IterationMilestone[] };

/** 前端预校验，返回第一条错误；服务端仍会完整校验。 */
export function iterationFormError(f: IterationForm): string | null {
  if (!f.name.trim()) return '请填写迭代名称';
  if (!f.startDate || !f.endDate) return '请填写开始和结束日期';
  if (f.startDate > f.endDate) return '结束日期不能早于开始日期';
  if (f.milestones.some((m) => !m.label.trim() || !m.date)) return '里程碑需要填写名称和日期';
  return null;
}
