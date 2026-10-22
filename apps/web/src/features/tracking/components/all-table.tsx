'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExpectedDateText } from '@/features/tracking/components/expected-date';
import { itemHref } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { AgingDays, LatestProgress, StageLabel, WriteButton } from './item-bits';
import { BatchStatusBar } from './batch-status';
import { NarrowTrackingList } from './narrow-list';

const dash = (v: string | null | undefined): string => v || '—';

/** 全部在手：每条一行。表格在自己的容器里横向滚动，标题列固定在左侧。 */
export function AllTable({ org, items, onWrite }: { org: string; items: TrackingItem[]; onWrite: (item: TrackingItem) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const picked = new Set(selected);
  const selectable = items.filter((i) => i.kind === 'work_item');
  const allOn = selectable.length > 0 && selectable.every((i) => picked.has(i.id));
  const toggle = (id: string, on: boolean) => setSelected((cur) => (on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id)));
  const toggleAll = (on: boolean) => setSelected(on ? selectable.map((i) => i.id) : []);
  return (
    <>
      <BatchStatusBar org={org} items={items} selected={selected} onClear={() => setSelected([])} />
      <NarrowTrackingList org={org} label="全部在手" items={items} onWrite={onWrite} className="rounded-md border bg-card" selected={picked} onToggle={toggle} />
      <div className="hidden min-w-0 rounded-md border bg-card md:block">
      <Table aria-label="全部在手" className="text-[13px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox aria-label="全选工作项" checked={allOn} disabled={selectable.length === 0} onCheckedChange={(on) => toggleAll(on === true)} />
            </TableHead>
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
            <TableHead className="sticky right-0 z-10 bg-card">
              <span className="sr-only">操作</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) => (
            <TableRow key={i.id} className="group h-10 even:bg-zebra">
              <TableCell>
                <Checkbox
                  aria-label={`选择 ${i.displayKey}`}
                  checked={i.kind === 'work_item' && picked.has(i.id)}
                  disabled={i.kind !== 'work_item'}
                  title={i.kind === 'work_item' ? undefined : '需求请在详情改状态'}
                  onCheckedChange={(on) => toggle(i.id, on === true)}
                />
              </TableCell>
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
              <TableCell className="font-mono text-xs">
                <ExpectedDateText expectedDate={i.expectedDate} done={i.done} />
              </TableCell>
              <TableCell className="font-mono text-xs">{dash(i.doneOn)}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">{i.wipDays} 天</TableCell>
              <TableCell className="sticky right-0 z-10 bg-card group-even:bg-zebra">
                <WriteButton item={i} onWrite={onWrite} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </>
  );
}
