'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, type ReactNode } from 'react';
import { Backlinks } from '@/components/backlinks';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ITERATION_STATUS_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import { useTask } from '@/lib/queries';

/** 任务详情（只读）：修改仍在迭代的甘特页签里进行。 */
export default function TaskPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const q = useTask(org, decodeURIComponent(key));
  if (!q.data && q.isError) {
    return <QueryError error={q.error} noAccessMessage="任务不存在，或你没有查看它所在产品的权限。" retryMessage="加载任务失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!q.data) return <Skeleton className="h-64" />;
  const t = q.data;
  const gantt = t.iteration ? `/${org}/iterations/${t.iteration.id}?tab=gantt` : null;
  const rows: Array<[string, ReactNode]> = [
    ['状态', TASK_STATUS_LABEL[t.status]],
    ['负责人', t.assignee?.displayName ?? '未指派'],
    [
      '开始 / 工期',
      <span key="plan" className="font-mono">
        {t.planStart ?? '未排期'}
        {t.planDays !== null && ` · ${t.planDays} 天`}
      </span>,
    ],
    ['进度', <span key="progress" className="font-mono">{t.progress}%</span>],
    [
      '需求',
      t.requirement ? (
        <Link key="req" href={`/${org}/requirements/${t.requirement.displayKey}`} className="hover:underline">
          <span className="font-mono">{t.requirement.displayKey}</span> {t.requirement.title}
        </Link>
      ) : (
        '未挂需求'
      ),
    ],
    [
      '迭代',
      t.iteration && gantt ? (
        <Link key="it" href={gantt} className="hover:underline">
          {t.iteration.name}（{ITERATION_STATUS_LABEL[t.iteration.status]}）
        </Link>
      ) : (
        '不在迭代中'
      ),
    ],
    ['说明', t.note ?? '—'],
  ];
  return (
    <>
      <PageHeader
        crumbs={[{ label: '迭代', href: `/${org}/iterations` }, ...(t.iteration && gantt ? [{ label: t.iteration.name, href: gantt }] : []), { label: t.displayKey }]}
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-muted-foreground">{t.displayKey}</span>
            <span className="min-w-0 break-words">{t.title}</span>
          </span>
        }
        description={gantt ? '任务在迭代的甘特页签里修改。' : undefined}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="任务信息" className="min-w-0 rounded-md border bg-card p-4">
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            {rows.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
        <Backlinks org={org} type="task" id={t.id} />
      </div>
    </>
  );
}
