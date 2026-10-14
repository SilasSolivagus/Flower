'use client';

import Link from 'next/link';
import { itemHref, ownerGroups } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { AgingDays, LatestProgress, StageLabel, WriteButton } from './item-bits';

/** 按产品经理：按负责人分组，组标题显示条数、暂停数、阻塞数、老化数；站会时按人逐个过。 */
export function OwnerGroups({ org, items, onWrite }: { org: string; items: TrackingItem[]; onWrite: (item: TrackingItem) => void }) {
  return (
    <div className="flex flex-col gap-4">
      {ownerGroups(items).map((g) => (
        <section key={g.id ?? 'none'} aria-label={g.name} className="min-w-0 rounded-md border bg-card">
          <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-sm font-semibold">
            {g.name}
            <span className="text-xs font-normal text-muted-foreground">
              {g.items.length} 条 · 暂停 {g.paused} · 阻塞 {g.blocked} · 老化 {g.aging}
            </span>
          </h2>
          <ul className="divide-y">
            {g.items.map((i) => (
              <li key={i.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-[13px]">
                <span className="font-mono text-xs text-muted-foreground">{i.displayKey}</span>
                <Link href={itemHref(org, i)} className="min-w-0 flex-1 truncate hover:underline">
                  {i.title}
                </Link>
                <StageLabel item={i} />
                <AgingDays item={i} />
                <span className="min-w-0 basis-full text-muted-foreground lg:basis-80">
                  <LatestProgress item={i} />
                </span>
                <WriteButton item={i} onWrite={onWrite} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
