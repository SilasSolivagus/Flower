'use client';

import Link from 'next/link';
import { Checkbox } from '@/components/ui/checkbox';
import { ExpectedDateText } from '@/features/tracking/components/expected-date';
import { itemHref } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { AgingDays, StageLabel, WriteButton } from './item-bits';

/** 窄屏跟进列表：阶段徽章完整可见，「写进展」在每条右侧，不靠横向滚动。md 及以上不渲染。 */
export function NarrowTrackingList({
  org,
  label,
  items,
  onWrite,
  className,
  selected,
  onToggle,
}: {
  org: string;
  label: string;
  items: TrackingItem[];
  onWrite: (item: TrackingItem) => void;
  className?: string;
  selected?: ReadonlySet<string>;
  onToggle?: (id: string, on: boolean) => void;
}) {
  return (
    <ul aria-label={label} className={cn('divide-y md:hidden', className)}>
      {items.map((i) => (
        <li key={i.id} className="flex flex-col gap-2 px-3 py-2.5 text-[13px]">
          <div className="flex items-start justify-between gap-3">
            {onToggle && (
              <Checkbox
                className="mt-1"
                aria-label={`选择 ${i.displayKey}`}
                checked={i.kind === 'work_item' && !!selected?.has(i.id)}
                disabled={i.kind !== 'work_item'}
                title={i.kind === 'work_item' ? undefined : '需求请在详情改状态'}
                onCheckedChange={(on) => onToggle(i.id, on === true)}
              />
            )}
            <div className="min-w-0">
              <span className="font-mono text-xs text-muted-foreground">{i.displayKey}</span>
              <Link href={itemHref(org, i)} className="block break-words hover:underline">
                {i.title}
              </Link>
            </div>
            <WriteButton item={i} onWrite={onWrite} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StageLabel item={i} />
            <AgingDays item={i} />
            <span className="text-xs text-muted-foreground">
              预计 <ExpectedDateText expectedDate={i.expectedDate} done={i.done} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
