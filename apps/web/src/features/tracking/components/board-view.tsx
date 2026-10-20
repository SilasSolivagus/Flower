'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { boardColumns, itemHref } from '@/features/tracking/model';
import type { TrackingItem, TrackingList } from '@/lib/types';
import { AgingDays, WriteButton } from './item-bits';

/** 按阶段看板：只读，不能拖动。列在自己的容器里横向滚动。 */
export function BoardView({ org, list, productId, onWrite }: { org: string; list: TrackingList; productId: string | null; onWrite: (item: TrackingItem) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 md:flex-row md:overflow-x-auto md:pb-2">
      {boardColumns(list, productId).map((c) => (
        <section key={c.key} aria-label={c.label} className="flex w-full min-w-0 flex-col gap-2 rounded-md border bg-muted/40 p-2 md:w-64 md:shrink-0">
          <h2 className="flex items-center gap-1.5 px-1 text-[13px] font-semibold">
            {c.color && <span className="size-2 rounded-full" style={{ background: c.color }} aria-hidden="true" />}
            {c.label}
            <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">{c.items.length}</span>
          </h2>
          {c.items.map((i) => (
            <article key={i.id} aria-label={`${i.displayKey} ${i.title}`} className="flex flex-col gap-1.5 rounded-md border bg-card p-2 text-[13px]">
              <Link href={itemHref(org, i)} className="line-clamp-2 hover:underline">
                {i.title}
              </Link>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">{i.displayKey}</span>
                {i.owner && <span>{i.owner.displayName}</span>}
                <AgingDays item={i} />
                {i.paused && <Badge variant="outline">已暂停</Badge>}
                {i.blockers.count > 0 && <span className="text-destructive">阻塞 {i.blockers.count}</span>}
              </div>
              <div className="self-start">
                <WriteButton item={i} onWrite={onWrite} />
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
