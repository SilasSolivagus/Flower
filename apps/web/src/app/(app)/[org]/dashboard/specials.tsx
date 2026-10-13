'use client';

import { EmptyNote } from '@/features/dashboard/components/empty-note';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatRate, METRIC_HELP } from '@/features/dashboard/model';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import type { ProductDashboard } from '@/lib/types';

/** 专项：每个专项的完成率进度条（只统计本产品的需求）。 */
export function SpecialsSection({ specials }: { specials: ProductDashboard['specials'] }) {
  return (
    <section aria-label="专项" className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <h2 className="text-base font-semibold">专项</h2>
        <MetricHelp label="专项完成率" text={METRIC_HELP.special} />
      </div>
      {specials.length === 0 ? (
        <EmptyNote text="暂无数据：时间段内没有包含本产品需求的专项" />
      ) : (
        <ul className="flex flex-col gap-3 rounded-md border bg-card p-3">
          {specials.map((s) => {
            const pct = Math.round((s.rate ?? 0) * 100);
            return (
              <li key={s.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-muted-foreground">
                    {ITERATION_STATUS_LABEL[s.status]} · {s.startDate} 至 {s.endDate}
                  </span>
                  <span className="ml-auto font-mono">
                    {formatRate(s.rate)}（{s.completed} / {s.total - s.canceled}）
                  </span>
                </div>
                <div
                  {...(s.rate === null
                    ? { 'aria-hidden': true }
                    : { role: 'progressbar', 'aria-label': s.name, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-valuetext': formatRate(s.rate) })}
                  className="h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
