'use client';

import { FolderTree } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { documentHref } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { levelLabel } from '@/features/structure/model';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useLevelNames, useModuleDocuments } from '@/lib/queries';
import type { DocumentDetail, Product } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 「模块文档」页签：按业务域 → 模块列出，是否已有文档、功能点数、最近合入时间。点击没有文档的模块即新建（产品编辑及以上）。 */
export function ModuleDocsTab({ org, product, focusNodeId }: { org: string; product: Product; focusNodeId: string | null }) {
  const router = useRouter();
  const tree = useModuleDocuments(org, product.id);
  const levels = useLevelNames(org, product.id);
  const names = levels.data?.names ?? [];
  const canCreate = product.myRole !== 'viewer';
  const create = useApiMutation((nodeId: string) => api<{ document: DocumentDetail }>(`/orgs/${org}/nodes/${nodeId}/module-document`, { method: 'POST' }), {
    silentError: true,
    invalidate: [documentKeys(org)],
    onSuccess: (r) => router.push(documentHref(org, r.document.displayKey)),
  });
  // 链接卡、面包屑或结构树带着 ?node= 跳过来：列表渲染后滚动到这个模块
  useEffect(() => {
    if (!focusNodeId || !tree.data) return;
    document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focusNodeId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusNodeId, tree.data]);

  if (tree.isError) return <QueryError error={tree.error} noAccessMessage="你没有查看这个产品的权限。" retryMessage="加载模块文档失败，请重试。" onRetry={() => tree.refetch()} />;
  if (!tree.data) return <Skeleton className="h-48" />;
  const domainLabel = levelLabel(names, 1);
  const moduleLabel = levelLabel(names, 2);
  if (tree.data.groups.length === 0) {
    return (
      <EmptyState
        icon={FolderTree}
        title={`结构树还没有${domainLabel}`}
        description={`模块文档按${moduleLabel}建立。产品管理员可以在产品设置的结构树页签中添加${domainLabel}；${moduleLabel}也可以在变更 PRD 声明影响时当场新建。`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <FormError error={create.error} />
      <div className="overflow-x-auto rounded-md border bg-card">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[36%]">{moduleLabel}</TableHead>
              <TableHead className="w-32">模块文档</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-20">{levelLabel(names, 3)}</TableHead>
              <TableHead className="w-36">最近合入</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tree.data.groups.map((g) => (
              <Fragment key={g.domain.id}>
                <TableRow className="h-10 bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={5} className="truncate text-[13px] font-medium">
                    {g.domain.name}
                    {g.domain.status === 'deprecated' && '（已停用）'}
                  </TableCell>
                </TableRow>
                {g.modules.length === 0 && (
                  <TableRow className="h-10">
                    <TableCell colSpan={5} className="pl-8 text-[13px] text-muted-foreground">
                      还没有{moduleLabel}
                    </TableCell>
                  </TableRow>
                )}
                {g.modules.map((m) => {
                  const focused = m.node.id === focusNodeId;
                  return (
                    <TableRow key={m.node.id} data-node-id={m.node.id} aria-current={focused ? 'true' : undefined} className={cn('h-10 even:bg-zebra', focused && 'bg-primary/5 even:bg-primary/5')}>
                      <TableCell className="truncate pl-8">
                        {m.document ? (
                          <Link href={documentHref(org, m.document.displayKey)} className="hover:underline">
                            {m.node.name}
                          </Link>
                        ) : canCreate ? (
                          <button type="button" className="hover:underline disabled:opacity-50" disabled={create.isPending} onClick={() => create.mutate(m.node.id)}>
                            {m.node.name}
                          </button>
                        ) : (
                          m.node.name
                        )}
                        {m.node.status === 'deprecated' && <span className="text-muted-foreground">（已停用）</span>}
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">
                        {m.document ? (
                          <Link href={documentHref(org, m.document.displayKey)} className="hover:underline">
                            {m.document.displayKey}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">未建</span>
                        )}
                      </TableCell>
                      <TableCell>{m.document && <DocumentStatusBadge status={m.document.status} />}</TableCell>
                      <TableCell className="font-mono text-[13px]">{m.featureCount}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{m.lastMergedAt ? formatDateTime(m.lastMergedAt) : '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
