import { expectedDateView, localDateIso } from '@/features/tracking/model';

/** 预计日：空写「未设置」；未完成且早于今天时用弱色标「已逾期」。 */
export function ExpectedDateText({ expectedDate, done, today }: { expectedDate: string | null; done: boolean; today?: string }) {
  const view = expectedDateView(expectedDate, { done, today: today ?? localDateIso(new Date()) });
  return (
    <span data-testid="expected-date" className={view.overdue ? 'text-amber-800 dark:text-amber-200/80' : undefined}>
      {view.text}
      {view.overdue && <span className="ml-1 text-[12px]">已逾期</span>}
    </span>
  );
}
