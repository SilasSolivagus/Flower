'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CHANGE_TYPE_LABEL, MERGE_STATUS_LABEL } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, useAffectedNodes, useApiMutation } from '@/lib/queries';
import type { AffectedNode, DocumentDetail } from '@/lib/types';
import { cn } from '@/lib/utils';
import { AffectedNodeDialog } from './affected-node-dialog';

/** 变更 PRD 侧栏「影响的功能点」：声明列表、增删改，已上线时进入合入页。 */
export function AffectedNodes({ org, doc }: { org: string; doc: DocumentDetail }) {
  const q = useAffectedNodes(org, doc.id);
  // seq 让每次打开对话框都重新挂载，初值取当时的声明
  const [editing, setEditing] = useState<{ item: AffectedNode | null; seq: number } | null>(null);
  const remove = useApiMutation((nodeId: string) => api(`/orgs/${org}/documents/${doc.id}/affected-nodes/${nodeId}`, { method: 'DELETE' }), {
    invalidate: [documentKeys(org)],
    success: '已移除',
  });
  const open = (item: AffectedNode | null) => setEditing((e) => ({ item, seq: (e?.seq ?? 0) + 1 }));
  const a = q.data;
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-affected-title">
      <h2 id="doc-affected-title" className="mb-2 text-sm font-semibold">
        影响的功能点
      </h2>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="没有查看影响声明的权限。" retryMessage="加载影响声明失败，请重试。" onRetry={() => q.refetch()} />
      ) : !a ? (
        <Skeleton className="h-12" />
      ) : (
        <>
          {a.items.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">还没有声明影响的功能点</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {a.items.map((it) => (
                <li key={it.nodeId} className="flex min-w-0 flex-col gap-1 py-2 text-[13px]">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={it.path}>
                      {it.path}
                    </span>
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs">{CHANGE_TYPE_LABEL[it.changeType]}</span>
                  </div>
                  {it.sourceSections.length > 0 && (
                    <p className="break-words text-xs text-muted-foreground">
                      来源：
                      {it.sourceSections.map((s, i) => (
                        <span key={s.key}>
                          {i > 0 && '、'}
                          <span className={cn(s.stale && 'line-through')}>{s.key}</span>
                          {s.stale && '（已失效）'}
                        </span>
                      ))}
                    </p>
                  )}
                  {it.mergeStatus !== 'pending' && <p className="text-xs text-muted-foreground">{MERGE_STATUS_LABEL[it.mergeStatus]}</p>}
                  {a.editable && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`修改 ${it.path}`} onClick={() => open(it)}>
                        修改
                      </Button>
                      <ConfirmAction
                        trigger={
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`移除 ${it.path}`} disabled={remove.isPending}>
                            移除
                          </Button>
                        }
                        title={`移除「${it.path}」？`}
                        description="只移除这条影响声明，结构树里的功能点保留。"
                        confirmLabel="移除"
                        onConfirm={() => remove.mutate(it.nodeId)}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {a.locked && <p className="mt-2 text-xs text-muted-foreground">已开始合入，声明在合入页处理。</p>}
          {(a.editable || (a.items.length > 0 && (doc.status === 'launched' || doc.status === 'merged'))) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {a.editable && (
                <Button size="sm" variant="outline" onClick={() => open(null)}>
                  声明影响
                </Button>
              )}
              {a.items.length > 0 && (doc.status === 'launched' || doc.status === 'merged') && (
                <Button size="sm" asChild>
                  <Link href={`/${org}/documents/${doc.displayKey}/merge`}>{doc.status === 'launched' ? '合入模块文档' : '查看合入'}</Link>
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {editing && a && <AffectedNodeDialog key={editing.seq} org={org} doc={doc} affected={a} item={editing.item} onClose={() => setEditing(null)} />}
    </section>
  );
}
