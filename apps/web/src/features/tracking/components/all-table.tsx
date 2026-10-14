'use client';

import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { itemHref } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { AgingDays, LatestProgress, StageLabel, WriteButton } from './item-bits';

const dash = (v: string | null | undefined): string => v || '—';

/** 全部在手：每条一行。表格在自己的容器里横向滚动，标题列固定在左侧。 */
export function AllTable({ org, items, onWrite }: { org: string; items: TrackingItem[]; onWrite: (item: TrackingItem) => void }) {
  return (
    <div className="min-w-0 rounded-md border bg-card">
      <Table aria-label="全部在手" className="text-[13px]">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-20">编号</TableHead>
            <TableHead className="sticky left-0 z-10 min-w-56 bg-card">标题</TableHead>
            <TableHead>负责人</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>当前阶段</TableHead>
            <TableHead>本阶段停留</TableHead>
            <TableHead>优先级</TableHead>
            <TableHead>启动日期</TableHead>
            <TableHead>进入当前阶段</TableHead>
            <TableHead>阻塞/风险</TableHead>
            <TableHead>最新进展 · 下一步 · 跟进人</TableHead>
            <TableHead>预计上线</TableHead>
            <TableHead>实际上线</TableHead>
            <TableHead>在制时长</TableHead>
            <TableHead>
              <span className="sr-only">操作</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) => (
            <TableRow key={i.id} className="group h-10 even:bg-zebra">
              <TableCell className="font-mono text-xs text-muted-foreground">{i.displayKey}</TableCell>
              <TableCell className="sticky left-0 z-10 max-w-72 bg-card group-even:bg-zebra">
                <Link href={itemHref(org, i)} className="block truncate hover:underline">
                  {i.title}
                </Link>
              </TableCell>
              <TableCell className="whitespace-nowrap">{dash(i.owner?.displayName)}</TableCell>
              <TableCell className="whitespace-nowrap">{dash(i.type?.label)}</TableCell>
              <TableCell>
                <StageLabel item={i} />
              </TableCell>
              <TableCell>
                <AgingDays item={i} />
              </TableCell>
              <TableCell>{dash(i.priority?.label)}</TableCell>
              <TableCell className="font-mono text-xs">{i.startedOn}</TableCell>
              <TableCell className="font-mono text-xs">{i.stageEnteredOn}</TableCell>
              <TableCell className="max-w-48">
                {i.blockers.count > 0 ? (
                  <span className="block truncate" title={i.blockers.first ?? undefined}>
                    <span className="font-mono text-destructive">{i.blockers.count}</span> {i.blockers.first}
                  </span>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell>
                <LatestProgress item={i} />
              </TableCell>
              <TableCell className="font-mono text-xs">{dash(i.expectedDate)}</TableCell>
              <TableCell className="font-mono text-xs">{dash(i.doneOn)}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">{i.wipDays} 天</TableCell>
              <TableCell>
                <WriteButton item={i} onWrite={onWrite} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
