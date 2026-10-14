'use client';

import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate } from '@/features/requirements/format';
import { agingRows, itemHref, staleRows } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { AgingDays, StageLabel, WriteButton } from './item-bits';

function ShortTable({ org, label, items, last, onWrite }: { org: string; label: string; items: TrackingItem[]; last: 'blockers' | 'latest'; onWrite: (item: TrackingItem) => void }) {
  return (
    <Table aria-label={label} className="text-[13px]">
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-20">编号</TableHead>
          <TableHead className="sticky left-0 z-10 min-w-56 bg-card">标题</TableHead>
          <TableHead>负责人</TableHead>
          <TableHead>当前阶段</TableHead>
          <TableHead>本阶段停留</TableHead>
          <TableHead>{last === 'blockers' ? '阻塞/风险' : '最近进展'}</TableHead>
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
            <TableCell className="whitespace-nowrap">{i.owner?.displayName ?? '—'}</TableCell>
            <TableCell>
              <StageLabel item={i} />
            </TableCell>
            <TableCell>
              <AgingDays item={i} />
            </TableCell>
            <TableCell className="max-w-56 truncate">
              {last === 'blockers'
                ? i.blockers.count > 0
                  ? `${i.blockers.count} 条 · ${i.blockers.first}`
                  : '—'
                : i.latest
                  ? formatDate(i.latest.createdAt)
                  : '没有进展记录'}
            </TableCell>
            <TableCell>
              <WriteButton item={i} onWrite={onWrite} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 任务老化：未完成的条目按本阶段停留降序（超过阈值标黄或标红）；下方单列超过阈值天数没有进展记录的条目。 */
export function AgingView({ org, items, staleDays, onWrite }: { org: string; items: TrackingItem[]; staleDays: number; onWrite: (item: TrackingItem) => void }) {
  const rows = agingRows(items);
  const stale = staleRows(items);
  const staleTitle = `超过 ${staleDays} 天没有进展记录`;
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="按本阶段停留排序" className="min-w-0 rounded-md border bg-card">
        <h2 className="border-b px-4 py-2.5 text-sm font-semibold">按本阶段停留排序</h2>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">没有未完成的条目</p>
        ) : (
          <ShortTable org={org} label="按本阶段停留排序" items={rows} last="blockers" onWrite={onWrite} />
        )}
      </section>
      <section aria-label={staleTitle} className="min-w-0 rounded-md border bg-card">
        <h2 className="flex items-center justify-between border-b px-4 py-2.5 text-sm font-semibold">
          {staleTitle}
          <span className="font-mono text-xs font-normal text-muted-foreground">{stale.length}</span>
        </h2>
        {stale.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">没有超过 {staleDays} 天没有进展的条目</p>
        ) : (
          <ShortTable org={org} label={staleTitle} items={stale} last="latest" onWrite={onWrite} />
        )}
      </section>
    </div>
  );
}
