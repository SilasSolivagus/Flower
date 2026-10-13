'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyNote } from '@/features/dashboard/components/empty-note';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatDays, formatRate, METRIC_HELP } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

/** 评审：各检查项的评审天数中位数与驳回率；注明统计起点（迁移来的历史评审不计入）。 */
export function ReviewSection({ review }: { review: ProductDashboard['review'] }) {
  return (
    <section aria-label="评审" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <h2 className="text-base font-semibold">评审</h2>
        <MetricHelp label="评审效率与驳回率" text={`${METRIC_HELP.reviewDays}${METRIC_HELP.rejection}`} />
        {review.since && <span className="text-xs text-muted-foreground">统计起点 {review.since}：只统计在 Flower 里记录的检查项变化，迁移来的历史评审不计入</span>}
      </div>
      {review.items.length === 0 ? (
        <EmptyNote text={review.since ? '暂无数据：时间段内没有有结论的检查项' : '暂无数据：还没有在 Flower 里评审过的检查项'} />
      ) : (
        <div className="min-w-0 rounded-md border bg-card">
          <Table aria-label="各检查项评审">
            <TableHeader>
              <TableRow>
                <TableHead>检查项</TableHead>
                <TableHead className="w-20 text-right">通过数</TableHead>
                <TableHead className="w-32 text-right">评审天数中位数</TableHead>
                <TableHead className="w-20 text-right">有结论</TableHead>
                <TableHead className="w-20 text-right">驳回过</TableHead>
                <TableHead className="w-20 text-right">驳回率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {review.items.map((i) => (
                <TableRow key={i.itemKey} className="h-10 even:bg-zebra">
                  <TableCell className="text-[13px]">{i.label}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{i.passed}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{formatDays(i.medianDays)}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{i.concluded}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{i.rejected}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{formatRate(i.rejectionRate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
