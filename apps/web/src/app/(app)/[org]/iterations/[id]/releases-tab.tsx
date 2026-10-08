'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { editableIterationProducts } from '@/features/iterations/model';
import { api } from '@/lib/api';
import { releaseStatusText } from '@/lib/labels';
import { releaseKeys, requirementKeys, useApiMutation, useProducts, useReleases } from '@/lib/queries';
import type { IterationDetail, Release } from '@/lib/types';
import { LinkRequirementsDialog } from './link-requirements-dialog';
import { ReleaseDialog } from './release-dialog';

export function ReleasesTab({ org, iteration: it }: { org: string; iteration: IterationDetail }) {
  const products = useProducts(org);
  const editable = editableIterationProducts(products.data ?? [], it);
  const q = useReleases(org, `iteration=${it.id}`);
  const [dialog, setDialog] = useState<{ open: boolean; release: Release | null }>({ open: false, release: null });
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const linking = q.data?.find((r) => r.id === linkingId) ?? null;
  const markReleased = useApiMutation((id: string) => api(`/orgs/${org}/releases/${id}/released`, { method: 'POST' }), {
    invalidate: [releaseKeys(org), requirementKeys(org)],
    success: '已标记为已发布',
  });

  if (q.isError) return <LoadError message="加载发布版本失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-32" />;
  return (
    <div className="flex flex-col gap-3">
      {editable.length > 0 && (
        <Button className="self-start" onClick={() => setDialog({ open: true, release: null })}>
          新建发布版本
        </Button>
      )}
      {q.data.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">还没有发布版本</p>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本号</TableHead>
                {!it.product && <TableHead className="w-20">产品</TableHead>}
                <TableHead className="w-28">平台</TableHead>
                <TableHead className="w-28">计划日期</TableHead>
                <TableHead className="w-28">基线日期</TableHead>
                <TableHead className="w-32">状态</TableHead>
                <TableHead className="w-16 text-right">需求</TableHead>
                <TableHead className="sticky right-0 z-10 w-56 bg-card" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((r) => (
                <TableRow key={r.id} className="group h-10 even:bg-zebra">
                  <TableCell className="font-mono">{r.versionName}</TableCell>
                  {!it.product && <TableCell className="font-mono text-[13px]">{r.productKey}</TableCell>}
                  <TableCell className="text-[13px]">{r.platform?.label ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px]">{r.plannedDate ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px]">{r.baselineDate ?? '—'}</TableCell>
                  <TableCell className="text-[13px]">{releaseStatusText(r)}</TableCell>
                  <TableCell className="text-right font-mono">{r.requirementCount}</TableCell>
                  <TableCell className="sticky right-0 z-10 bg-card text-right group-even:bg-zebra">
                    {r.canEdit && (
                      <>
                        <Button variant="ghost" size="sm" aria-label={`关联需求 ${r.versionName}`} onClick={() => setLinkingId(r.id)}>
                          关联需求
                        </Button>
                        <Button variant="ghost" size="sm" aria-label={`编辑 ${r.versionName}`} onClick={() => setDialog({ open: true, release: r })}>
                          编辑
                        </Button>
                        {r.status === 'planned' && (
                          <ConfirmAction
                            trigger={
                              <Button variant="ghost" size="sm" aria-label={`标记发布 ${r.versionName}`} disabled={markReleased.isPending}>
                                标记发布
                              </Button>
                            }
                            title={`标记「${r.versionName}」为已发布？`}
                            description="发布时间记为现在，之后不能撤回。"
                            confirmLabel="标记发布"
                            onConfirm={() => markReleased.mutate(r.id)}
                          />
                        )}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ReleaseDialog org={org} open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} iteration={it} release={dialog.release} products={editable} />
      <LinkRequirementsDialog key={linkingId ?? 'closed'} org={org} iteration={it} release={linking} onClose={() => setLinkingId(null)} />
    </div>
  );
}
