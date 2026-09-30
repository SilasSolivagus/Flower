'use client';

import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { commitmentRate } from '@/features/iterations/model';
import { formatDate } from '@/features/requirements/format';
import { useIterationScope } from '@/lib/queries';
import type { IterationScope } from '@/lib/types';

type Item = IterationScope['addedLater'][number];

function Bucket({ org, title, items, note }: { org: string; title: string; items: Item[]; note?: (i: Item) => string }) {
  return (
    <section aria-label={title} className="rounded-md border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold">
        {title}
        <span className="ml-2 font-mono text-muted-foreground">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">无</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2">
              <Link className="font-mono hover:underline" href={`/${org}/requirements/${i.displayKey}`}>
                {i.displayKey}
              </Link>
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: i.state.color }} aria-hidden="true" />
                {i.state.label}
              </span>
              {note && <span className="text-muted-foreground">{note(i)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ScopeTab({ org, iterationId }: { org: string; iterationId: string }) {
  const q = useIterationScope(org, iterationId);
  if (q.isError) return <LoadError message="加载范围对比失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-40" />;
  const s = q.data;
  if (!s.hasSnapshot) {
    return (
      <div className="flex flex-col gap-3">
        <p role="note" className="rounded-md border bg-muted px-3 py-2 text-[13px]">
          该迭代没有承诺范围记录（开始时迭代为空，或为迁移的历史数据），无法区分承诺内与中途加入。以下为当前范围。
        </p>
        <Bucket org={org} title="当前范围" items={s.addedLater} />
      </div>
    );
  }
  const rate = commitmentRate(s);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">
        承诺范围记录于 <span className="font-mono">{s.snapshotAt ? formatDate(s.snapshotAt) : '—'}</span>，承诺完成率 {rate === null ? '—' : `${rate}%`}。
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Bucket org={org} title="承诺内已完成" items={s.committedDone} />
        <Bucket org={org} title="承诺内未完成" items={s.committedOpen} />
        <Bucket org={org} title="中途加入" items={s.addedLater} />
        <Bucket org={org} title="中途移出" items={s.removed} note={(i) => (i.currentIteration ? `现在在「${i.currentIteration.name}」` : '未排期')} />
      </div>
    </div>
  );
}
