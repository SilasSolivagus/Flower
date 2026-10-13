'use client';

import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { CARD_SPECS, cardDelta, cardLabel, emptyReason, formatMetric, METRIC_HELP, TONE_CLASS } from '@/features/dashboard/model';
import type { DashboardCards } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MetricHelp } from './metric-help';

/** 六个关键数字：数值、口径说明，以及与上一个同长度时间段相比的升降；没有数据时显示原因。 */
export function MetricCards({ cards, completedCount, endsToday }: { cards: DashboardCards; completedCount: number; endsToday: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {CARD_SPECS.map((s) => {
        const label = cardLabel(s, endsToday);
        const pair = cards[s.key];
        const delta = cardDelta(pair, s.unit, s.better);
        const Icon = delta?.direction === 'up' ? TrendingUp : delta?.direction === 'down' ? TrendingDown : Minus;
        return (
          <section key={s.key} aria-label={label} className="flex min-w-0 flex-col gap-1 rounded-md border bg-card p-3">
            <div className="flex items-center gap-1 text-[13px] text-muted-foreground">
              <span className="truncate">{label}</span>
              <MetricHelp label={label} text={METRIC_HELP[s.help]} />
            </div>
            <div className={cn('font-mono text-xl font-semibold', pair.value === null && 'text-base font-normal text-muted-foreground')}>{formatMetric(pair.value, s.unit)}</div>
            {pair.value === null ? (
              <p className="text-xs text-muted-foreground">{emptyReason(s.key, completedCount)}</p>
            ) : delta ? (
              <p className={cn('flex items-center gap-1 text-xs', TONE_CLASS[delta.tone])}>
                <Icon className="size-3.5" aria-hidden="true" />
                {delta.text}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">上期暂无数据</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
