'use client';

import { ChartColumn } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterBar } from '@/features/dashboard/components/filter-bar';
import { InvalidFilter } from '@/features/dashboard/components/invalid-filter';
import { MetricCards } from '@/features/dashboard/components/metric-cards';
import { type DashboardFilter, DEFAULT_FILTER, dashboardHref, filterFromParams, filterQuery } from '@/features/dashboard/model';
import { ApiError } from '@/lib/api';
import { useProductDashboard, useProducts } from '@/lib/queries';
import type { ProductDashboard } from '@/lib/types';
import { Trends } from './trends';

/** 筛选栏之下的各区块，自上而下与设计 §4.1 一致。 */
function Sections({ data }: { org: string; data: ProductDashboard }) {
  return (
    <>
      <MetricCards cards={data.cards} completedCount={data.completedCount} endsToday={data.window.endsToday} />
      <Trends weeks={data.weeks} />
    </>
  );
}

function DashboardPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const products = useProducts(org);
  const product = (products.data ?? []).find((p) => p.id === params.get('product')) ?? products.data?.[0];
  const filter = filterFromParams(params);
  const query = filterQuery(filter);
  const q = useProductDashboard(org, product?.id, query);
  const go = (productId: string, f: DashboardFilter) => router.replace(dashboardHref(org, productId, f), { scroll: false });

  let body: ReactNode;
  if (!products.data && products.isError) {
    body = <QueryError error={products.error} noAccessMessage="组织不存在，或者你没有查看权限。" retryMessage="加载产品列表失败，请重试。" onRetry={() => products.refetch()} />;
  } else if (products.data && products.data.length === 0) {
    body = <EmptyState icon={ChartColumn} title="还没有产品" description="组织管理员新建产品后，这里显示产品的需求流速、版本与评审数据。" />;
  } else if (!q.data) {
    if (q.error instanceof ApiError && q.error.status === 400 && product) {
      body = <InvalidFilter message={q.error.message} onReset={() => go(product.id, DEFAULT_FILTER)} />;
    } else if (q.isError) {
      body = <QueryError error={q.error} noAccessMessage="产品不存在，或你没有查看权限。" retryMessage="加载看板失败，请重试。" onRetry={() => q.refetch()} />;
    } else {
      body = <Skeleton className="h-64" />;
    }
  } else {
    const data = q.data;
    body = (
      <>
        <FilterBar key={`${data.product.id}:${query}`} filter={filter} range={data.window} iterations={data.iterationOptions} onChange={(f) => go(data.product.id, f)} />
        <Sections org={org} data={data} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="看板"
        description="打开时按当前数据计算；时间段与周按组织时区划分，周从周一开始；已删除的需求不计。"
        actions={
          (products.data?.length ?? 0) > 1 &&
          product && (
            <Select value={product.id} onValueChange={(v) => go(v, DEFAULT_FILTER)}>
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

export default function Page() {
  return (
    <Suspense>
      <DashboardPage />
    </Suspense>
  );
}
