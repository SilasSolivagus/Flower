'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { customRangeError, type DashboardFilter, DEFAULT_FILTER, RANGE_OPTIONS, rangeValue, windowText } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

type RangeData = ProductDashboard['window'];
type IterationOption = ProductDashboard['iterationOptions'][number];

/** 自定义时间段：填好两个日期后点「应用」才生效；不合法时显示原因并禁用「应用」。 */
function CustomRange({ initial, today, onApply }: { initial: { from: string; to: string }; today: string; onApply: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const error = customRangeError(from, to, today);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="date" aria-label="开始日期" className="h-8 w-40" max={today} value={from} onChange={(e) => setFrom(e.target.value)} />
      <span className="text-[13px] text-muted-foreground">至</span>
      <Input type="date" aria-label="结束日期" className="h-8 w-40" max={today} value={to} onChange={(e) => setTo(e.target.value)} />
      <Button size="sm" variant="outline" disabled={error !== null} onClick={() => onApply(from, to)}>
        应用
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

/**
 * 筛选栏：近 30 / 90 / 180 天、自定义，与「按迭代」切换（只在传入 iterations 时显示）。
 * 筛选写在地址栏，由调用方通过 onChange 改写；调用方用 key 在筛选变化时重新挂载本组件。
 */
export function FilterBar({
  filter,
  range,
  iterations,
  onChange,
}: {
  filter: DashboardFilter;
  range: RangeData;
  iterations?: IterationOption[];
  onChange: (f: DashboardFilter) => void;
}) {
  const [customOpen, setCustomOpen] = useState(filter.kind === 'custom');
  const byIteration = filter.kind === 'iteration';
  const showCustom = !byIteration && customOpen;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {iterations && (
          <Button
            size="sm"
            variant={byIteration ? 'secondary' : 'outline'}
            aria-pressed={byIteration}
            disabled={!byIteration && iterations.length === 0}
            title={iterations.length === 0 ? '还没有已开始的迭代' : undefined}
            onClick={() => onChange(byIteration ? DEFAULT_FILTER : { kind: 'iteration', iterationId: iterations[0]!.id })}
          >
            按迭代
          </Button>
        )}
        {byIteration ? (
          <Select value={filter.iterationId} onValueChange={(v) => onChange({ kind: 'iteration', iterationId: v })}>
            <SelectTrigger className="h-8 w-72 max-w-full" aria-label="迭代">
              <SelectValue placeholder="选择迭代" />
            </SelectTrigger>
            <SelectContent>
              {(iterations ?? []).map((it) => (
                <SelectItem key={it.id} value={it.id}>
                  {it.name}（{it.startDate} 至 {it.endDate}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Select
            value={showCustom ? 'custom' : rangeValue(filter)}
            onValueChange={(v) => {
              if (v === 'custom') {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange({ kind: 'days', days: v === '30' ? 30 : v === '180' ? 180 : 90 });
            }}
          >
            <SelectTrigger className="h-8 w-32" aria-label="时间段">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {showCustom && <CustomRange initial={filter.kind === 'custom' ? { from: filter.from, to: filter.to } : { from: range.from, to: range.to }} today={range.today} onApply={(from, to) => onChange({ kind: 'custom', from, to })} />}
      </div>
      <div role="group" aria-label="统计时间段">
        <p className="text-[13px] text-muted-foreground">{windowText(range)}</p>
      </div>
    </div>
  );
}
