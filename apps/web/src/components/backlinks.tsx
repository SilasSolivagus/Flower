'use client';

import Link from 'next/link';
import { useId } from 'react';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { backlinkViaLabel } from '@/features/links/model';
import { formatDateTime } from '@/features/requirements/format';
import { useBacklinks } from '@/lib/queries';
import type { BacklinkTargetType } from '@/lib/types';

/** 「被引用」区块：别处手写的 [[ ]] 引用，按来源对象分组，每条显示来源、上下文与时间。 */
export function Backlinks({ org, type, id }: { org: string; type: BacklinkTargetType; id: string }) {
  const q = useBacklinks(org, type, id);
  const titleId = useId();
  const count = q.data?.reduce((n, g) => n + g.items.length, 0);
  return (
    <section className="min-w-0 rounded-md border bg-card p-4" aria-labelledby={titleId}>
      <h2 id={titleId} className="mb-2 text-sm font-semibold">
        被引用 {count !== undefined && <span className="font-mono text-xs text-muted-foreground">{count}</span>}
      </h2>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="没有查看引用的权限。" retryMessage="加载引用失败，请重试。" onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-12" />
      ) : q.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有被引用</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {q.data.map((g) => (
            <li key={`${g.kind}:${g.id}`} className="flex min-w-0 flex-col gap-1">
              <Link href={`/${org}/${g.href}`} className="flex min-w-0 gap-2 text-[13px] hover:underline">
                <span className="shrink-0 font-mono text-muted-foreground">{g.displayKey}</span>
                <span className="truncate">{g.title}</span>
              </Link>
              <ul className="ml-3 flex flex-col gap-1.5 border-l pl-3">
                {g.items.map((it, i) => (
                  <li key={i} className="flex min-w-0 flex-col text-[12px] text-muted-foreground">
                    <span>
                      <span className="text-foreground">{backlinkViaLabel(it)}</span> · <span className="font-mono">{formatDateTime(it.createdAt)}</span>
                    </span>
                    <span className="break-words">{it.context}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
