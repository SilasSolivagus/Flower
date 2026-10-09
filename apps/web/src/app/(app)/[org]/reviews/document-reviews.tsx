'use client';

import Link from 'next/link';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { documentHref } from '@/features/documents/model';
import { cellText, waitingText } from '@/features/reviews/model';
import { useDocumentReviews } from '@/lib/queries';

/** PRD 评审表：评审中的 PRD，每个作用于 PRD 的检查项一列；流程没有这类检查项时不显示。 */
export function DocumentReviews({ org, productId }: { org: string; productId: string }) {
  const q = useDocumentReviews(org, productId);
  if (q.isError) return <QueryError error={q.error} noAccessMessage="没有查看 PRD 评审的权限。" retryMessage="加载 PRD 评审失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-24" />;
  if (q.data.columns.length === 0) return null;
  return (
    <section aria-labelledby="doc-reviews-title" className="flex flex-col gap-2">
      <h2 id="doc-reviews-title" className="text-sm font-semibold">
        PRD 评审
      </h2>
      {q.data.rows.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">没有评审中的 PRD</p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">编号</TableHead>
                <TableHead>标题</TableHead>
                <TableHead className="w-24">负责人</TableHead>
                {q.data.columns.map((c) => (
                  <TableHead key={c.key} className="w-28">
                    {c.label}
                  </TableHead>
                ))}
                <TableHead className="w-20">
                  <span className="sr-only">待签</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.rows.map((r) => (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-[13px]">
                    <Link href={documentHref(org, r.displayKey)} className="hover:underline">
                      {r.displayKey}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-80 truncate">{r.title}</TableCell>
                  <TableCell className="text-[13px]">{r.owner?.displayName ?? '—'}</TableCell>
                  {q.data.columns.map((c) => (
                    <TableCell key={c.key} className="text-[13px]">
                      {cellText(r.cells[c.key]!)}
                    </TableCell>
                  ))}
                  <TableCell className="text-[12px] text-primary">{waitingText(r.waiting)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
