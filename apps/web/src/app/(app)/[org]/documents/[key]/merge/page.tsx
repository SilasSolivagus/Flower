'use client';

import { GitMerge } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { documentHref } from '@/features/documents/model';
import { useDocument, useMergePlan } from '@/lib/queries';
import type { MergePlan } from '@/lib/types';
import { MergeItemCard } from './merge-item';

function applyBlockedOf(g: MergePlan['groups'][number]): string | null {
  if (g.module === null) return '功能点已不在模块下，只能跳过';
  if (g.document?.status === 'archived') return '模块文档已归档，恢复为使用中后才能应用';
  return null;
}

/** 合入页：按模块分组，逐个功能点把变更 PRD 的来源小节合入模块文档。 */
function MergePage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const d = useDocument(org, decodeURIComponent(key));
  const plan = useMergePlan(org, d.data?.id);
  // 已有数据时后台刷新失败不替换整页，避免卡片里没应用的修改丢失
  if (!d.data && d.isError) {
    return <QueryError error={d.error} noAccessMessage="PRD 不存在，或你没有查看它所在产品的权限。" retryMessage="加载 PRD 失败，请重试。" onRetry={() => d.refetch()} />;
  }
  if (!plan.data && plan.isError) {
    return <QueryError error={plan.error} noAccessMessage="没有查看合入的权限。" retryMessage="加载合入内容失败，请重试。" onRetry={() => plan.refetch()} />;
  }
  if (!d.data || !plan.data) return <Skeleton className="h-64" />;
  const p = plan.data;
  return (
    <>
      <PageHeader
        crumbs={[
          { label: '文档', href: `/${org}/documents?product=${d.data.productKey}` },
          { label: p.document.displayKey, href: documentHref(org, p.document.displayKey) },
          { label: '合入模块文档' },
        ]}
        title="合入模块文档"
        description={`${p.document.displayKey} ${p.document.title}`}
        actions={<DocumentStatusBadge status={p.document.status} />}
      />
      <p role="status" className="text-[13px] text-muted-foreground">
        已处理 {p.done} / {p.total}
        {p.document.status === 'merged' && '，全部处理完，PRD 已变为「已合入」'}
      </p>
      {p.total === 0 ? (
        <EmptyState icon={GitMerge} title="还没有影响声明" description="先在 PRD 详情的「影响的功能点」里声明要合入的功能点。" />
      ) : (
        p.groups.map((g) => (
          <section key={g.module?.id ?? 'none'} aria-label={g.module?.path ?? '不在模块下的功能点'} className="flex min-w-0 flex-col gap-3">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {g.module?.path ?? '不在模块下的功能点'}
              {g.document ? (
                <Link href={documentHref(org, g.document.displayKey)} className="font-mono text-[13px] font-normal text-muted-foreground hover:underline">
                  {g.document.displayKey}
                </Link>
              ) : (
                g.module && <span className="text-[13px] font-normal text-muted-foreground">模块文档将在第一次应用时自动新建</span>
              )}
            </h2>
            {g.items.map((it) => (
              <MergeItemCard key={it.nodeId} org={org} documentId={p.document.id} baseVersion={g.document?.version ?? null} item={it} canMerge={p.canMerge} applyBlocked={applyBlockedOf(g)} canReopen={p.canReopen} onRefresh={() => void plan.refetch()} />
            ))}
          </section>
        ))
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <MergePage />
    </Suspense>
  );
}
