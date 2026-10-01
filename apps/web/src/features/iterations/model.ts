import type { Iteration, IterationMilestone, Product } from '@/lib/types';

export type IterationGroup = { key: string; title: string; iterations: Iteration[] };

/** 迭代内可管理需求/发布版本的产品：本人非只读，且（专项迭代不限，常规迭代仅本产品）。 */
export function editableIterationProducts(products: Product[], iteration: { product: { id: string } | null }): Product[] {
  return products.filter((p) => p.myRole !== 'viewer' && (!iteration.product || p.id === iteration.product.id));
}

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

export const ITERATION_TABS = ['requirements', 'gantt', 'scope', 'releases'] as const;
export type IterationTab = (typeof ITERATION_TABS)[number];

/** 地址栏的 ?tab= 转成页签；不认识的值和未开始迭代的「范围对比」都回到「需求」。 */
export function iterationTab(raw: string | null, started: boolean): IterationTab {
  const tab = (ITERATION_TABS as readonly string[]).includes(raw ?? '') ? (raw as IterationTab) : 'requirements';
  return tab === 'scope' && !started ? 'requirements' : tab;
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

const CANCEL_CONFIRM = '取消后不能恢复，也不能再加入需求。';

export const STATUS_ACTIONS: Record<Iteration['status'], Array<{ to: Iteration['status']; label: string; confirm: string }>> = {
  planning: [
    { to: 'active', label: '开始迭代', confirm: '开始后会锁定基线结束日期，并把当前迭代中的需求记为承诺范围。' },
    { to: 'canceled', label: '取消迭代', confirm: CANCEL_CONFIRM },
  ],
  active: [
    { to: 'done', label: '完成迭代', confirm: '完成后不能再修改迭代，也不能再加入需求。' },
    { to: 'canceled', label: '取消迭代', confirm: CANCEL_CONFIRM },
  ],
  done: [],
  canceled: [],
};

/** 承诺完成率（%）：承诺内已完成 ÷ 承诺总数；中途移出的也算在承诺总数里。 */
export function commitmentRate(scope: { committedDone: unknown[]; committedOpen: unknown[]; removed: unknown[] }): number | null {
  const total = scope.committedDone.length + scope.committedOpen.length + scope.removed.length;
  return total === 0 ? null : Math.round((scope.committedDone.length / total) * 100);
}
