'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadError } from '@/components/load-error';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { localToday, milestoneTimeline, STATUS_ACTIONS } from '@/features/iterations/model';
import { ApiError, api } from '@/lib/api';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import { iterationKeys, useApiMutation, useIteration } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ReleasesTab } from './releases-tab';
import { RequirementsTab } from './requirements-tab';
import { ScopeTab } from './scope-tab';

export default function IterationPage() {
  const { org, id } = useParams<{ org: string; id: string }>();
  const router = useRouter();
  const q = useIteration(org, id);
  const [today] = useState(localToday);
  const setStatus = useApiMutation((to: string) => api(`/orgs/${org}/iterations/${id}/status`, { method: 'POST', body: { to } }), {
    invalidate: [iterationKeys(org)],
    success: '已更新迭代状态',
  });
  const remove = useApiMutation(() => api(`/orgs/${org}/iterations/${id}`, { method: 'DELETE' }), {
    invalidate: [iterationKeys(org)],
    success: '已删除迭代',
    onSuccess: () => router.push(`/${org}/iterations`),
  });

  if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403)) return <NoAccess message="迭代不存在，或你没有查看它的权限。" />;
  if (q.isError) return <LoadError message="加载迭代失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-64" />;
  const it = q.data;
  const timeline = milestoneTimeline(it.milestones, today);
  const started = it.status !== 'planning';

  return (
    <>
      <PageHeader
        crumbs={[{ label: '迭代', href: `/${org}/iterations` }, { label: it.name }]}
        title={it.name}
        description={
          <>
            {it.product ? it.product.name : '专项'} · <span className="font-mono">{it.startDate} ~ {it.endDate}</span>
            {it.baselineEndDate && it.baselineEndDate !== it.endDate && (
              <>
                {' '}
                · 基线结束 <span className="font-mono">{it.baselineEndDate}</span>
              </>
            )}{' '}
            · <span data-testid="iteration-status">{ITERATION_STATUS_LABEL[it.status]}</span>
          </>
        }
        actions={
          it.canManage && (
            <>
              {STATUS_ACTIONS[it.status].map((a) => (
                <ConfirmAction
                  key={a.to}
                  trigger={
                    <Button variant={a.to === 'canceled' ? 'outline' : 'default'} disabled={setStatus.isPending}>
                      {a.label}
                    </Button>
                  }
                  title={`${a.label}「${it.name}」？`}
                  description={a.confirm}
                  confirmLabel={a.label}
                  destructive={a.to === 'canceled'}
                  onConfirm={() => setStatus.mutate(a.to)}
                />
              ))}
              {it.status === 'planning' && it.requirementCount === 0 && (
                <ConfirmAction
                  trigger={<Button variant="ghost">删除</Button>}
                  title={`删除「${it.name}」？`}
                  description="只有规划中、没有需求和发布版本的迭代可以删除。"
                  confirmLabel="删除"
                  destructive
                  onConfirm={() => remove.mutate(undefined)}
                />
              )}
            </>
          )
        }
      />
      {timeline.length > 0 && (
        <ol aria-label="里程碑" className="flex flex-wrap gap-2">
          {timeline.map((m, i) => (
            <li key={i} className={cn('flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px]', m.past ? 'bg-muted text-muted-foreground' : 'bg-card')}>
              <span className={cn('size-2 rounded-full', m.past ? 'bg-muted-foreground/50' : 'bg-primary')} aria-hidden="true" />
              <span>{m.label}</span>
              <span className="font-mono">{m.date}</span>
              <span className="text-xs">{m.past ? '已过' : '未到'}</span>
            </li>
          ))}
        </ol>
      )}
      <Tabs defaultValue="requirements">
        <TabsList>
          <TabsTrigger value="requirements">需求（{it.requirementCount}）</TabsTrigger>
          {started && <TabsTrigger value="scope">范围对比</TabsTrigger>}
          <TabsTrigger value="releases">发布版本</TabsTrigger>
        </TabsList>
        <TabsContent value="requirements">
          <RequirementsTab org={org} iteration={it} />
        </TabsContent>
        {started && (
          <TabsContent value="scope">
            <ScopeTab org={org} iterationId={it.id} />
          </TabsContent>
        )}
        <TabsContent value="releases">
          <ReleasesTab org={org} iteration={it} />
        </TabsContent>
      </Tabs>
    </>
  );
}
