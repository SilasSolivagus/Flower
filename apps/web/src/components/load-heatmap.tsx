import Link from 'next/link';
import type { CSSProperties } from 'react';
import { HEAT_CLASSES, type HeatRow, heatClass, shortDate } from '@/features/gantt/model';
import { cn } from '@/lib/utils';

/** 工作日列头：第一列留给名称，之后隔一列显示日期，今天加粗。热力图与时间轴共用。 */
export function DayHeader({ days, today, style, className }: { days: string[]; today: string; style: CSSProperties; className?: string }) {
  return (
    <div className={cn('grid text-[10px] text-muted-foreground', className)} style={style}>
      <span />
      {days.map((d, i) => (
        <span key={d} className={cn('text-center font-mono', d === today && 'font-semibold text-foreground')}>
          {i % 2 === 0 || d === today ? shortDate(d) : ''}
        </span>
      ))}
    </div>
  );
}

/** 人员 × 工作日的负载热力图（push 的规则）；姓名链接到人员负载页。 */
export function LoadHeatmap({ org, title, days, rows, max, today }: { org: string; title: string; days: string[]; rows: HeatRow[]; max: number; today: string }) {
  const cols = { gridTemplateColumns: `112px repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <section aria-label={title} className="flex flex-col gap-1.5 overflow-x-auto rounded-md border bg-card p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">没有已指派负责人的任务</p>
      ) : (
        <>
          <DayHeader days={days} today={today} style={cols} className="gap-1" />
          {rows.map((r) => (
            <div key={r.id} className="grid items-center gap-1" style={cols}>
              <Link href={`/${org}/workload?member=${r.id}`} className="truncate pr-2 text-[12px] hover:underline">
                {r.name}
              </Link>
              {r.counts.map((c, i) => (
                <span key={days[i]} title={`${r.name} ${shortDate(days[i]!)}：${c} 个任务`} data-count={c} className={cn('h-5 rounded-sm', heatClass(c, max))} />
              ))}
            </div>
          ))}
          <div className="flex items-center gap-1 pt-1 text-[10px] text-muted-foreground">
            少
            {HEAT_CLASSES.map((c) => (
              <span key={c} className={cn('inline-block size-3 rounded-sm', c)} />
            ))}
            多 · 周末不显示
          </div>
        </>
      )}
    </section>
  );
}
