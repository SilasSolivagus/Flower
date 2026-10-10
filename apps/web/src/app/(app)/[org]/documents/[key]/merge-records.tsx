'use client';

import Link from 'next/link';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { CHANGE_TYPE_LABEL, documentHref } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { useMergeRecords } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 模块文档的合入记录：按版本倒序列出来自哪些变更 PRD、哪些功能点。功能点的历史即其中对应它的部分。 */
export function MergeRecords({ org, doc }: { org: string; doc: DocumentDetail }) {
  const q = useMergeRecords(org, doc.id);
  return (
    <section className="min-w-0 rounded-md border bg-card p-4" aria-labelledby="doc-merges-title">
      <h2 id="doc-merges-title" className="mb-2 text-sm font-semibold">
        合入记录
      </h2>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="没有查看合入记录的权限。" retryMessage="加载合入记录失败，请重试。" onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-12" />
      ) : q.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有合入记录</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {q.data.map((r) => (
            <li key={r.revisionNumber} className="flex min-w-0 flex-col gap-0.5 py-2 text-[13px]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{r.feature.name}</span>
                <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs">{CHANGE_TYPE_LABEL[r.changeType]}</span>
              </div>
              <Link href={documentHref(org, r.changeDocument.displayKey)} className="flex min-w-0 gap-2 text-muted-foreground hover:underline">
                <span className="shrink-0 font-mono">{r.changeDocument.displayKey}</span>
                <span className="truncate">{r.changeDocument.title}</span>
              </Link>
              <span className="text-xs text-muted-foreground">
                第 {r.revisionNumber} 版 · {r.by?.displayName ?? '—'} · <span className="font-mono">{formatDateTime(r.mergedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
