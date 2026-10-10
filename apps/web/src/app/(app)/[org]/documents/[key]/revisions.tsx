'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { documentHref, SECTION_CHANGE_LABEL } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useDocumentDiff, useDocumentRevisions } from '@/lib/queries';
import type { DocumentDetail, DocumentRevision } from '@/lib/types';
import { cn } from '@/lib/utils';

const LINE_STYLE = { add: 'bg-primary/10 text-primary', del: 'bg-destructive/10 text-destructive line-through', same: 'text-muted-foreground' } as const;
const LINE_MARK = { add: '+', del: '-', same: ' ' } as const;

function DiffDialog({ org, docId, revisions, initial, onClose }: { org: string; docId: string; revisions: DocumentRevision[]; initial: { from: number; to: number }; onClose: () => void }) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const diff = useDocumentDiff(org, docId, from, to);
  const picker = (label: string, value: number, onChange: (n: number) => void) => (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-8 w-28" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {revisions.map((r) => (
          <SelectItem key={r.number} value={String(r.number)}>
            第 {r.number} 版
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>对比修订</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 text-[13px]">
          从 {picker('从', from, setFrom)} 到 {picker('到', to, setTo)}
        </div>
        {from === to ? (
          <p className="text-[13px] text-muted-foreground">请选择两个不同的版本</p>
        ) : diff.isError ? (
          <QueryError error={diff.error} noAccessMessage="没有查看这份 PRD 的权限。" retryMessage="加载对比失败，请重试。" onRetry={() => diff.refetch()} />
        ) : !diff.data ? (
          <Skeleton className="h-32" />
        ) : !diff.data.title && diff.data.sections.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">两版内容相同</p>
        ) : (
          <div className="flex flex-col gap-3">
            {diff.data.title && (
              <p className="text-[13px]">
                标题：<span className="line-through">{diff.data.title.old}</span> → {diff.data.title.new}
              </p>
            )}
            {diff.data.sections.map((s) => (
              <section key={`${s.change}:${s.key}`} aria-label={s.heading ?? '开头'} className="rounded-md border">
                <header className="flex items-center gap-2 border-b px-3 py-1.5 text-[13px]">
                  <span className="rounded-sm bg-muted px-1.5 text-xs">{SECTION_CHANGE_LABEL[s.change]}</span>
                  <span className="font-medium">{s.key}</span>
                </header>
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-5">
                  {s.lines.map((l, i) => (
                    <div key={i} className={cn('whitespace-pre-wrap', LINE_STYLE[l.type])}>
                      {LINE_MARK[l.type]} {l.text}
                    </div>
                  ))}
                </pre>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 修订记录：版本列表（作者、时间、摘要），与上一版对比（对话框里可任选两版），恢复到旧版本（新建一版）。 */
export function Revisions({ org, doc, onRestored, saveEditor }: { org: string; doc: DocumentDetail; onRestored: () => void; saveEditor: () => Promise<number | null> }) {
  // 已归档的模块文档只读，不能恢复版本
  const canEdit = doc.myRole !== 'viewer' && doc.status !== 'archived';
  const list = useDocumentRevisions(org, doc.id);
  const [diff, setDiff] = useState<{ from: number; to: number } | null>(null);
  const restore = useApiMutation(
    async (number: number) => {
      // 用编辑器的版本号（含刚自动保存与改标题沿用的），缓存里的 doc.version 可能还没刷新
      const baseVersion = (await saveEditor()) ?? doc.version;
      return api(`/orgs/${org}/documents/${doc.id}/restore`, { method: 'POST', body: { number, baseVersion } });
    },
    {
      invalidate: [documentKeys(org)],
      success: '已恢复',
      onSuccess: () => onRestored(),
    },
  );
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-revisions-title">
      <h2 id="doc-revisions-title" className="mb-2 text-sm font-semibold">
        修订记录
      </h2>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="没有查看修订的权限。" retryMessage="加载修订失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="flex flex-col divide-y">
          {list.data.map((r) => (
            <li key={r.number} className="flex flex-col gap-1 py-2 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="font-medium">第 {r.number} 版</span>
                {r.number === doc.revisionNumber && <span className="rounded-sm bg-muted px-1.5 text-xs">当前</span>}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.author?.displayName ?? '—'}</span>
                <span className="font-mono text-xs text-muted-foreground">{formatDateTime(r.updatedAt)}</span>
              </div>
              {r.summary && <p className="text-xs text-muted-foreground">{r.summary}</p>}
              {r.mergedFrom && (
                <Link href={documentHref(org, r.mergedFrom.displayKey)} className="text-xs text-muted-foreground hover:underline" aria-label={`来源 ${r.mergedFrom.displayKey} ${r.mergedFrom.title}`}>
                  来源 <span className="font-mono">{r.mergedFrom.displayKey}</span>
                </Link>
              )}
              <div className="flex gap-1">
                {r.number > 1 && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`对比第 ${r.number} 版与上一版`} onClick={() => setDiff({ from: r.number - 1, to: r.number })}>
                    对比
                  </Button>
                )}
                {canEdit && r.number !== doc.revisionNumber && (
                  <ConfirmAction
                    trigger={
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`恢复第 ${r.number} 版`} disabled={restore.isPending}>
                        恢复
                      </Button>
                    }
                    title={`恢复到第 ${r.number} 版？`}
                    description="会以这一版的内容新建一版，之前的版本都保留。编辑器里还没保存的修改会先存成一版，再被替换。"
                    confirmLabel="恢复"
                    onConfirm={() => restore.mutate(r.number)}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {diff && list.data && <DiffDialog org={org} docId={doc.id} revisions={list.data} initial={diff} onClose={() => setDiff(null)} />}
    </section>
  );
}
