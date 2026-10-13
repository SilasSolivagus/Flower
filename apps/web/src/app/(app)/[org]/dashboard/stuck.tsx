'use client';

import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyNote } from '@/features/dashboard/components/empty-note';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatDays, METRIC_HELP } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

function StateDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

/** 卡在哪儿：当前各进行中状态的需求数与平均停留（停留降序），以及停留最久的前 10 条需求。 */
export function StuckSection({ org, stuck }: { org: string; stuck: ProductDashboard['stuck'] }) {
  return (
    <section aria-label="卡在哪儿" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <h2 className="text-base font-semibold">卡在哪儿</h2>
        <MetricHelp label="卡在哪儿" text={METRIC_HELP.stuck} />
        <span className="text-xs text-muted-foreground">按当前数据，不受时间段影响</span>
      </div>
      {stuck.states.length === 0 ? (
        <EmptyNote text="暂无数据：当前没有处于进行中类状态的需求" />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="min-w-0 rounded-md border bg-card">
            <Table aria-label="各状态停留">
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-20 text-right">需求数</TableHead>
                  <TableHead className="w-28 text-right">平均停留</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stuck.states.map((s) => (
                  <TableRow key={s.key} className="h-10 even:bg-zebra">
                    <TableCell className="text-[13px]">
                      <StateDot color={s.color} label={s.label} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{s.count}</TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{formatDays(s.avgDays)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="min-w-0 rounded-md border bg-card">
            <Table aria-label="停留最久的需求">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">编号</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-24 text-right">停留</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stuck.oldest.map((r) => (
                  <TableRow key={r.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-mono text-[13px]">
                      <Link href={`/${org}/requirements/${r.displayKey}`} className="hover:underline">
                        {r.displayKey}
                      </Link>
                    </TableCell>
                    <TableCell className="text-[13px]">
                      <Link href={`/${org}/requirements/${r.displayKey}`} className="block max-w-64 truncate hover:underline" title={r.title}>
                        {r.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-[13px]">
                      <StateDot color={r.state.color} label={r.state.label} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{formatDays(r.days)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
}
