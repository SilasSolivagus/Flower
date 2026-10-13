'use client';

import { ChartColumn } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FilterBar } from '@/features/dashboard/components/filter-bar';
import { InvalidFilter } from '@/features/dashboard/components/invalid-filter';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import {
  CARD_SPECS,
  cardDelta,
  cardLabel,
  type DashboardFilter,
  DEFAULT_FILTER,
  dashboardHref,
  emptyReason,
  filterFromParams,
  filterQuery,
  formatMetric,
  METRIC_HELP,
  orgDashboardHref,
  TONE_CLASS,
} from '@/features/dashboard/model';
import { ApiError } from '@/lib/api';
import { useOrgDashboard } from '@/lib/queries';
import type { OrgDashboard } from '@/lib/types';
import { cn } from '@/lib/utils';

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;

/** 每个产品一行，列出六个关键数字；箭头表示与上期相比的升降，颜色表示变好或变差。 */
function SummaryTable({ org, data, filter }: { org: string; data: OrgDashboard; filter: DashboardFilter }) {
  return (
    <div className="min-w-0 rounded-md border bg-card">
    <Table aria-label="各产品关键数字">
      <TableHeader>
        <TableRow>
          <TableHead className="sticky left-0 z-10 min-w-36 bg-card">产品</TableHead>
          {CARD_SPECS.map((s) => {
            const label = cardLabel(s, data.window.endsToday);
            return (
              <TableHead key={s.key} className="min-w-32">
                <span className="inline-flex items-center gap-1">
                  {label}
                  <MetricHelp label={label} text={METRIC_HELP[s.help]} />
                </span>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.products.map((p) => (
          <TableRow key={p.id} className="group h-10 even:bg-zebra">
            <TableCell className="sticky left-0 z-10 bg-card group-even:bg-zebra">
              <Link href={dashboardHref(org, p.id, filter)} className="hover:underline">
                {p.name}
              </Link>
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">{p.key}</span>
            </TableCell>
            {CARD_SPECS.map((s) => {
              const pair = p.cards[s.key];
              if (pair.value === null) {
                return (
                  <TableCell key={s.key} className="text-xs text-muted-foreground">
                    {formatMetric(null, s.unit)}
                    <span className="ml-1">（{emptyReason(s.key, p.completedCount)}）</span>
                  </TableCell>
                );
              }
              const delta = cardDelta(pair, s.unit, s.better);
              return (
                <TableCell key={s.key} className="font-mono text-[13px]">
                  {formatMetric(pair.value, s.unit)}
                  {delta && (
                    <span className={cn('ml-1 text-xs', TONE_CLASS[delta.tone])} title={delta.text}>
                      {ARROW[delta.direction]}
                      <span className="sr-only">{delta.text}</span>
                    </span>
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </div>
  );
}

function OrgDashboardPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const filter = filterFromParams(params, false);
  const query = filterQuery(filter);
  const q = useOrgDashboard(org, query);
  const go = (f: DashboardFilter) => router.replace(orgDashboardHref(org, f), { scroll: false });

  let body: ReactNode;
  if (!q.data) {
    if (q.error instanceof ApiError && q.error.status === 400) body = <InvalidFilter message={q.error.message} onReset={() => go(DEFAULT_FILTER)} />;
    else if (q.isError) body = <QueryError error={q.error} noAccessMessage="你没有查看组织汇总的权限。" retryMessage="加载组织汇总失败，请重试。" onRetry={() => q.refetch()} />;
    else body = <Skeleton className="h-40" />;
  } else {
    body = (
      <>
        <FilterBar key={query} filter={filter} range={q.data.window} onChange={go} />
        {q.data.products.length === 0 ? <EmptyState icon={ChartColumn} title="还没有产品" /> : <SummaryTable org={org} data={q.data} filter={filter} />}
      </>
    );
  }
  return (
    <>
      <PageHeader title="看板" description="按产品对比关键数字；点击产品名称进入该产品的看板。箭头表示与上一个同长度时间段相比的升降。" />
      {body}
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <Suspense>
        <OrgDashboardPage />
      </Suspense>
    </RequireOrgAdmin>
  );
}
