import { DayHeader } from '@/components/load-heatmap';
import { timelineCells } from '@/features/gantt/model';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 只读时间轴：按迭代的工作日画出每个有开始日期的任务，计划内与延期分色。 */
export function Timeline({ tasks, days, today }: { tasks: Task[]; days: string[]; today: string }) {
  const scheduled = tasks.filter((t) => t.planStart);
  const cols = { gridTemplateColumns: `180px repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <section aria-label="时间轴" className="flex flex-col gap-1 overflow-x-auto rounded-md border bg-card p-3">
      <h3 className="text-sm font-semibold">时间轴</h3>
      {scheduled.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">没有填写开始日期的任务</p>
      ) : (
        <>
          <DayHeader days={days} today={today} style={cols} className="gap-px" />
          {scheduled.map((t) => (
            <div key={t.id} className="grid items-center gap-px" style={cols}>
              <span className="truncate pr-2 text-[12px]" title={t.title}>
                {t.alias || t.title}
              </span>
              {timelineCells(t, days).map((kind, i) => (
                <span
                  key={days[i]}
                  data-kind={kind ?? undefined}
                  className={cn('h-4', kind === 'plan' ? 'bg-primary/70' : kind === 'delay' ? 'bg-destructive/60' : days[i] === today ? 'bg-muted' : '')}
                />
              ))}
            </div>
          ))}
          <p className="flex items-center gap-3 pt-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-4 bg-primary/70" />
              计划
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-4 bg-destructive/60" />
              延期
            </span>
            <span>周末不显示</span>
          </p>
        </>
      )}
    </section>
  );
}
