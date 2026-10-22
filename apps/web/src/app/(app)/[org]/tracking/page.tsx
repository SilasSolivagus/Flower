'use client';

import { ListChecks } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AgingView } from '@/features/tracking/components/aging-view';
import { AllTable } from '@/features/tracking/components/all-table';
import { BoardView } from '@/features/tracking/components/board-view';
import { TrackingFilterBar } from '@/features/tracking/components/filter-bar';
import { OwnerGroups } from '@/features/tracking/components/owner-groups';
import { WriteProgressDialog } from '@/features/tracking/components/progress-dialog';
import { CreateWorkItemDialog } from '@/features/tracking/components/work-item-dialog';
import {
  DEFAULT_FILTER,
  filterFromParams,
  filterQuery,
  hasFilter,
  type ProgressTarget,
  TAB_LABELS,
  TRACKING_TABS,
  type TrackingFilter,
  type TrackingTab,
  targetOf,
  trackingFilterSummary,
  trackingHref,
} from '@/features/tracking/model';
import { ApiError } from '@/lib/api';
import { useOrg, useTracking } from '@/lib/queries';
import type { TrackingItem, TrackingList } from '@/lib/types';

function TabBody({ org, data, filter, onWrite }: { org: string; data: TrackingList; filter: TrackingFilter; onWrite: (item: TrackingItem) => void }) {
  if (filter.tab === 'aging') return <AgingView org={org} items={data.items} staleDays={data.settings.staleUpdateDays} onWrite={onWrite} />;
  if (filter.tab === 'board') return <BoardView org={org} list={data} productId={filter.product} onWrite={onWrite} />;
  if (filter.tab === 'owners') return <OwnerGroups org={org} items={data.items} onWrite={onWrite} />;
  return <AllTable org={org} items={data.items} onWrite={onWrite} />;
}

function TrackingPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const filter = filterFromParams(params);
  const q = useTracking(org, filterQuery(filter));
  const orgQ = useOrg(org);
  const [writing, setWriting] = useState<ProgressTarget | null>(null);
  const [lastFollower, setLastFollower] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const go = (f: TrackingFilter) => router.replace(trackingHref(org, f), { scroll: false });
  const onWrite = (i: TrackingItem) => setWriting(targetOf(i));
  const filtered = hasFilter(filter);

  let body: ReactNode;
  if (!q.data) {
    if (q.error instanceof ApiError && q.error.status === 400) {
      body = (
        <EmptyState
          icon={ListChecks}
          title="筛选参数无效"
          description="地址栏里的筛选条件格式不正确。请清除后重新选择。"
          action={
            <Button variant="outline" onClick={() => go(DEFAULT_FILTER)}>
              清除筛选
            </Button>
          }
        />
      );
    } else if (q.isError) {
      body = <QueryError error={q.error} noAccessMessage="无法读取跟进列表。" retryMessage="加载跟进列表失败，请重试。" onRetry={() => q.refetch()} />;
    } else {
      body = <Skeleton className="h-64" />;
    }
  } else {
    const data = q.data;
    const summary = trackingFilterSummary(filter, data);
    const readOnly = data.items.length > 0 && data.items.every((i) => !i.canWrite);
    body = (
      <>
        <TrackingFilterBar list={data} filter={filter} onChange={go} />
        {readOnly && (
          <p role="status" className="text-[13px] text-muted-foreground">
            你对这些条目没有编辑权限，不能写进展。需要修改时请联系产品编辑。
          </p>
        )}
        <Tabs value={filter.tab} onValueChange={(v) => go({ ...filter, tab: v as TrackingTab })}>
          <TabsList>
            {TRACKING_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={filter.tab} className="mt-2 min-w-0">
            {data.items.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title={filtered ? '没有符合条件的条目' : '还没有在手的工作'}
                description={filtered ? summary || '当前筛选没有匹配的条目。' : '需求进入设计阶段后会自动加入跟进；技术支持、协调对接等工作可以新建为工作项。'}
                action={
                  filtered ? (
                    <Button variant="outline" onClick={() => go({ ...DEFAULT_FILTER, tab: filter.tab })}>
                      清除筛选
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <TabBody org={org} data={data} filter={filter} onWrite={onWrite} />
            )}
          </TabsContent>
        </Tabs>
        <WriteProgressDialog
          org={org}
          target={writing}
          defaultFollower={lastFollower}
          onOpenChange={(open) => {
            if (!open) setWriting(null);
          }}
          onSaved={setLastFollower}
        />
        <CreateWorkItemDialog org={org} products={data.products} open={creating} onOpenChange={setCreating} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="跟进"
        description="跨产品查看在手的需求与工作项：本阶段停留、阻塞、最新进展与下一步。"
        actions={orgQ.data && orgQ.data.me.orgRole !== 'guest' ? <Button onClick={() => setCreating(true)}>新建工作项</Button> : undefined}
      />
      {body}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <TrackingPage />
    </Suspense>
  );
}
