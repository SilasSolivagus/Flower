'use client';

import { ChevronDown, ChevronRight, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, type ReactNode, useState } from 'react';
import { CHECK_STATE_STYLE, CheckItems } from '@/components/check-items';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  cellText,
  DEFAULT_REVIEW_FILTER,
  REVIEW_FILTER_OPTIONS,
  REVIEW_STATE_LABEL,
  REVIEW_STATES,
  type ReviewFilter,
  reviewQuery,
  waitingText,
} from '@/features/reviews/model';
import { CHECK_STATE_LABEL } from '@/lib/labels';
import { useProducts, useRequirement, useReviewQueue } from '@/lib/queries';
import type { CheckState, ReviewFilterState, ReviewQueue } from '@/lib/types';
import { cn } from '@/lib/utils';

const ANY = 'any';

/** 展开行：复用需求详情的检查项组件（本人签字、代签对话框、普通检查项的状态下拉）。 */
function RowDetail({ org, displayKey }: { org: string; displayKey: string }) {
  const q = useRequirement(org, displayKey);
  if (!q.data) {
    if (q.isError) return <QueryError error={q.error} noAccessMessage="需求不存在，或你没有查看权限。" retryMessage="加载检查项失败，请重试。" onRetry={() => q.refetch()} />;
    return <Skeleton className="h-24" />;
  }
  return <CheckItems org={org} requirement={q.data} />;
}

function QueueTable({ org, queue }: { org: string; queue: ReviewQueue }) {
  const [open, setOpen] = useState<string | null>(null);
  if (queue.rows.length === 0) return <p className="py-8 text-center text-muted-foreground">没有符合条件的需求</p>;
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <span className="sr-only">展开</span>
            </TableHead>
            <TableHead className="w-24">编号</TableHead>
            <TableHead>标题</TableHead>
            <TableHead className="w-24">状态</TableHead>
            <TableHead className="w-24">负责人</TableHead>
            {queue.columns.map((c) => (
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
          {queue.rows.map((r) => {
            const expanded = open === r.id;
            const waiting = waitingText(r.waiting);
            return (
              <Fragment key={r.id}>
                <TableRow className="h-10 even:bg-zebra">
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${expanded ? '收起' : '展开'} ${r.displayKey}`}
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : r.id)}
                    >
                      {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{r.displayKey}</TableCell>
                  <TableCell>
                    <Link href={`/${org}/requirements/${r.displayKey}`} className="hover:underline">
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-[13px]" style={{ color: r.state.color }}>
                    {r.state.label}
                  </TableCell>
                  <TableCell className="text-[13px]">{r.owner?.displayName ?? '—'}</TableCell>
                  {queue.columns.map((c) => {
                    const cell = r.cells[c.key]!;
                    return (
                      <TableCell key={c.key} className={cn('text-[13px]', CHECK_STATE_STYLE[cell.state])}>
                        {cellText(cell)}
                      </TableCell>
                    );
                  })}
                  <TableCell>{waiting && <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{waiting}</span>}</TableCell>
                </TableRow>
                {expanded && (
                  <TableRow>
                    <TableCell colSpan={queue.columns.length + 6} className="bg-muted/40 p-3">
                      <RowDetail org={org} displayKey={r.displayKey} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Filters({ queue, filter, onChange }: { queue: ReviewQueue; filter: ReviewFilter; onChange: (patch: Partial<ReviewFilter>) => void }) {
  return (
    <>
      <div role="group" aria-label="评审统计" className="flex flex-wrap gap-2">
        {REVIEW_STATES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={filter.state === s ? 'secondary' : 'outline'}
            aria-pressed={filter.state === s}
            onClick={() => onChange({ state: filter.state === s ? 'open' : s })}
          >
            {REVIEW_STATE_LABEL[s]} <span className="font-mono">{queue.stats[s]}</span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={filter.state} onValueChange={(v) => onChange({ state: v as ReviewFilterState })}>
          <SelectTrigger className="h-8 w-48" aria-label="整体状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REVIEW_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.itemKey || ANY} onValueChange={(v) => onChange({ itemKey: v === ANY ? '' : v })}>
          <SelectTrigger className="h-8 w-40" aria-label="检查项">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部检查项</SelectItem>
            {queue.columns.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filter.itemKey && (
          <Select value={filter.itemState} onValueChange={(v) => onChange({ itemState: v as CheckState })}>
            <SelectTrigger className="h-8 w-28" aria-label="检查项状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CHECK_STATE_LABEL) as CheckState[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {CHECK_STATE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="flex items-center gap-2 text-[13px]">
          <Checkbox aria-label="等我签字" checked={filter.mine} onCheckedChange={(v) => onChange({ mine: v === true })} />
          等我签字
        </span>
      </div>
    </>
  );
}

export default function ReviewsPage() {
  const { org } = useParams<{ org: string }>();
  const products = useProducts(org);
  const [productId, setProductId] = useState('');
  const product = (products.data ?? []).find((p) => p.id === productId) ?? products.data?.[0];
  const [filter, setFilter] = useState<ReviewFilter>(DEFAULT_REVIEW_FILTER);
  const q = useReviewQueue(org, product?.id, reviewQuery(filter));
  const change = (patch: Partial<ReviewFilter>) => setFilter((f) => ({ ...f, ...patch }));

  let body: ReactNode;
  if (!products.data && products.isError) {
    body = <QueryError error={products.error} noAccessMessage="组织不存在，或者你没有查看权限。" retryMessage="加载产品列表失败，请重试。" onRetry={() => products.refetch()} />;
  } else if (products.data && products.data.length === 0) {
    body = <EmptyState icon={ClipboardCheck} title="还没有产品" />;
  } else if (!q.data) {
    body = q.isError ? (
      <QueryError error={q.error} noAccessMessage="产品不存在，或你没有查看权限。" retryMessage="加载评审表失败，请重试。" onRetry={() => q.refetch()} />
    ) : (
      <Skeleton className="h-64" />
    );
  } else if (q.data.columns.length === 0) {
    body = <EmptyState icon={ClipboardCheck} title="这个产品的流程没有配置检查项" description="组织管理员可以在「流程模板」里给流程添加检查项。" />;
  } else {
    body = (
      <>
        <Filters queue={q.data} filter={filter} onChange={change} />
        <QueueTable org={org} queue={q.data} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="评审"
        description="按流程里配置的检查项批量查看评审进度；展开一行即可签字或代签。"
        actions={
          (products.data?.length ?? 0) > 1 && (
            <Select
              value={product?.id}
              onValueChange={(v) => {
                setProductId(v);
                setFilter(DEFAULT_REVIEW_FILTER);
              }}
            >
              <SelectTrigger className="h-8 w-40" aria-label="产品">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {products.data!.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        }
      />
      {body}
    </>
  );
}
