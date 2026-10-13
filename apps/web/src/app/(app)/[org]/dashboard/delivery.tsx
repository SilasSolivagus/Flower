'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyNote } from '@/features/dashboard/components/empty-note';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatRate, METRIC_HELP, releaseVerdict, TONE_CLASS } from '@/features/dashboard/model';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import type { ProductDashboard } from '@/lib/types';
import { cn } from '@/lib/utils';

function IterationTable({ rows }: { rows: ProductDashboard['iterations'] }) {
  return (
    <section aria-label="迭代承诺" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-semibold">迭代承诺完成率</h3>
        <MetricHelp label="迭代承诺完成率" text={METRIC_HELP.commitment} />
      </div>
      {rows.length === 0 ? (
        <EmptyNote text="暂无数据：时间段内还没有在 Flower 里开始的迭代" />
      ) : (
        <>
          {rows.every((r) => !r.hasSnapshot) && (
            <p role="note" className="rounded-md border bg-muted px-3 py-2 text-[13px]">
              还没有在 Flower 里开始的迭代：以下迭代没有承诺范围快照（如迁移来的历史迭代），承诺完成率显示「暂无数据」。
            </p>
          )}
          <div className="min-w-0 rounded-md border bg-card">
            <Table aria-label="迭代承诺">
              <TableHeader>
                <TableRow>
                  <TableHead>迭代</TableHead>
                  <TableHead className="w-48">时间</TableHead>
                  <TableHead className="w-20">状态</TableHead>
                  <TableHead className="w-44 text-right">承诺完成率</TableHead>
                  <TableHead className="w-24 text-right">完成 / 承诺</TableHead>
                  <TableHead className="w-20 text-right">中途加入</TableHead>
                  <TableHead className="w-16 text-right">移出</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="h-10 even:bg-zebra">
                    <TableCell className="text-[13px]">{r.name}</TableCell>
                    <TableCell className="font-mono text-[12px]">
                      {r.startDate} 至 {r.endDate}
                    </TableCell>
                    <TableCell className="text-[13px]">{ITERATION_STATUS_LABEL[r.status]}</TableCell>
                    <TableCell className={cn('text-right font-mono text-[13px]', r.rate === null && 'text-muted-foreground')}>
                      {formatRate(r.rate)}
                      {r.reason && <span className="ml-1.5 font-sans text-[11px]">{r.reason}</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{r.reason === null ? `${r.completed} / ${r.committed - r.canceled}` : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{r.added ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{r.removed ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}

function ReleaseTable({ releases }: { releases: ProductDashboard['releases'] }) {
  return (
    <section aria-label="版本" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <h3 className="text-sm font-semibold">版本</h3>
        <MetricHelp label="版本按期达成率" text={METRIC_HELP.releaseOnTime} />
        <span className="ml-2 text-[13px] text-muted-foreground">
          按期达成率 <span className="font-mono text-foreground">{formatRate(releases.onTimeRate)}</span>（可判断 {releases.evaluated} 个，按期 {releases.onTime} 个）
        </span>
      </div>
      {releases.rows.length === 0 ? (
        <EmptyNote text="暂无数据：没有已发布或计划中的版本" />
      ) : (
        <div className="min-w-0 rounded-md border bg-card">
          <Table aria-label="版本">
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead className="w-48">计划日</TableHead>
                <TableHead className="w-28">实际发布日</TableHead>
                <TableHead className="w-64">是否按期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.rows.map((r) => {
                const verdict = releaseVerdict(r);
                return (
                  <TableRow key={r.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-mono text-[13px]">{r.versionName}</TableCell>
                    <TableCell className="font-mono text-[13px]">{r.dueDate ?? '—'}</TableCell>
                    <TableCell className="font-mono text-[13px]">{r.releasedOn ?? '未发布'}</TableCell>
                    <TableCell className={cn('text-[13px]', TONE_CLASS[verdict.tone])}>{verdict.text}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/** 迭代与版本：每个迭代一行（承诺完成率、中途加入与移出）；每个版本一行（计划日、实际发布日、是否按期）。 */
export function DeliverySection({ iterations, releases }: { iterations: ProductDashboard['iterations']; releases: ProductDashboard['releases'] }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">迭代与版本</h2>
      <IterationTable rows={iterations} />
      <ReleaseTable releases={releases} />
    </div>
  );
}
