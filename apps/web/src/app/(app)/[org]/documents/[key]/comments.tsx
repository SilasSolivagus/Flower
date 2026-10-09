'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { WikiText } from '@/components/wiki-text';
import { WikilinkTextarea } from '@/components/wikilink-textarea';
import type { SelectionAnchor } from '@/features/documents/editor/selection';
import { ANCHOR_STATE_LABEL, groupThreads } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { linkKeys, qk, useApiMutation, useDocumentComments, useOrg } from '@/lib/queries';
import type { DocumentComment, DocumentDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

function Quote({ c }: { c: DocumentComment }) {
  if (!c.anchor && c.anchorState !== 'unanchored') return null;
  return (
    <div className="flex flex-col gap-1">
      {c.anchor && <blockquote className="border-l-2 pl-2 text-[12px] text-muted-foreground">{c.anchor.quote}</blockquote>}
      <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
        {c.anchor?.sectionHeading && <span>位于「{c.anchor.sectionHeading}」</span>}
        {(c.anchorState === 'stale' || c.anchorState === 'unanchored') && (
          <span className="rounded-sm bg-amber-100 px-1.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{ANCHOR_STATE_LABEL[c.anchorState]}</span>
        )}
      </p>
    </div>
  );
}

/** PRD 评论区：整篇评论、回复、标为已解决；划词评论显示引用原文、所在小节与失效标记。 */
export function DocumentComments({ org, doc, focus = null }: { org: string; doc: DocumentDetail; focus?: { id: string; seq: number } | null }) {
  // 正文里点了某条评论的高亮：滚动到这条（seq 变化时同一条也会再滚动一次）
  useEffect(() => {
    if (focus) document.getElementById(`comment-${focus.id}`)?.scrollIntoView({ block: 'center' });
  }, [focus]);
  // 打开 PRD 详情即把评论标为已读（与需求详情一致）；只读 Token 会被拒绝，静默忽略
  const read = useApiMutation(() => api(`/orgs/${org}/documents/${doc.id}/comments/read`, { method: 'POST' }), { invalidate: [qk.workbench], silentError: true });
  const readMutate = read.mutate;
  useEffect(() => {
    readMutate(undefined);
  }, [doc.id, readMutate]);
  const orgQ = useOrg(org);
  const list = useDocumentComments(org, doc.id);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const invalidate = [qk.documentComments(org, doc.id), linkKeys(org)];
  const add = useApiMutation((v: { body: string; parentId?: string }) => api(`/orgs/${org}/documents/${doc.id}/comments`, { method: 'POST', body: v }), {
    silentError: true,
    invalidate,
    success: '已发表',
  });
  const resolve = useApiMutation((v: { id: string; resolved: boolean }) => api(`/orgs/${org}/document-comments/${v.id}/resolve`, { method: 'POST', body: { resolved: v.resolved } }), {
    invalidate,
  });
  const me = orgQ.data?.me.memberId;
  const canResolve = (c: DocumentComment) => doc.myRole !== 'viewer' || c.author?.id === me;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-comments-title">
      <h2 id="doc-comments-title" className="mb-3 text-sm font-semibold">
        评论
      </h2>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="没有查看评论的权限。" retryMessage="加载评论失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-20" />
      ) : list.data.length === 0 ? (
        <p className="mb-3 text-[13px] text-muted-foreground">还没有评论。在正文里选中文字可以针对那段话评论。</p>
      ) : (
        <ul className="mb-3 flex flex-col divide-y">
          {groupThreads(list.data).map(({ comment: c, replies }) => (
            <li
              key={c.id}
              id={`comment-${c.id}`}
              aria-current={focus?.id === c.id ? 'true' : undefined}
              className={cn('flex flex-col gap-2 py-3', focus?.id === c.id && '-mx-2 rounded-sm bg-amber-50 px-2 dark:bg-amber-900/20')}
            >
              <Quote c={c} />
              <p className="text-[12px] text-muted-foreground">
                {c.author?.displayName ?? '已删除的成员'} · <span className="font-mono">{formatDateTime(c.createdAt)}</span>
                {c.resolvedAt && <span className="ml-2 rounded-sm bg-muted px-1.5">已解决</span>}
              </p>
              <WikiText org={org} text={c.body} cards={c.links} productKey={doc.productKey} className="text-[13px]" />
              {replies.length > 0 && (
                <ul className="ml-4 flex flex-col gap-2 border-l pl-3">
                  {replies.map((r) => (
                    <li key={r.id} className="text-[13px]">
                      <span className="text-[12px] text-muted-foreground">{r.author?.displayName ?? '已删除的成员'}：</span>
                      <WikiText org={org} text={r.body} cards={r.links} productKey={doc.productKey} as="span" />
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[12px]"
                  onClick={() => {
                    setReplyTo(c.id);
                    setReply('');
                  }}
                >
                  回复
                </Button>
                {canResolve(c) && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: c.id, resolved: !c.resolvedAt })}>
                    {c.resolvedAt ? '重新打开' : '标为已解决'}
                  </Button>
                )}
              </div>
              {replyTo === c.id && (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    add.mutate({ body: reply, parentId: c.id }, { onSuccess: () => setReplyTo(null) });
                  }}
                >
                  <WikilinkTextarea org={org} productId={doc.productId} aria-label="回复内容" className="min-h-16 text-[13px]" value={reply} onValueChange={setReply} />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={add.isPending || !reply.trim()}>
                      发送回复
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setReplyTo(null)}>
                      取消
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ body }, { onSuccess: () => setBody('') });
        }}
      >
        <WikilinkTextarea org={org} productId={doc.productId} aria-label="发表评论" placeholder="对整篇 PRD 的意见" className="min-h-20 text-[13px]" value={body} onValueChange={setBody} />
        <FormError error={add.error} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={add.isPending || !body.trim()}>
            发表
          </Button>
        </div>
      </form>
    </section>
  );
}

/** 选中正文文字后的评论对话框。 */
export function AnchorCommentDialog({ documentId, productId, anchor, onClose }: { documentId: string; productId: string; anchor: SelectionAnchor | null; onClose: () => void }) {
  const { org } = useParams<{ org: string }>();
  const [body, setBody] = useState('');
  const [completing, setCompleting] = useState(false);
  const add = useApiMutation(() => api(`/orgs/${org}/documents/${documentId}/comments`, { method: 'POST', body: { body, anchor } }), {
    silentError: true,
    invalidate: [qk.documentComments(org, documentId), linkKeys(org)],
    success: '已发表',
    onSuccess: () => {
      setBody('');
      onClose();
    },
  });
  return (
    <Dialog
      open={!!anchor}
      onOpenChange={(o) => {
        if (!o) {
          add.reset();
          onClose();
        }
      }}
    >
      <DialogContent onEscapeKeyDown={(e) => { if (completing) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>评论选中的文字</DialogTitle>
        </DialogHeader>
        <blockquote className="border-l-2 pl-2 text-[13px] text-muted-foreground">{anchor?.quote}</blockquote>
        <WikilinkTextarea org={org} productId={productId} aria-label="评论内容" className="min-h-20 text-[13px]" value={body} onValueChange={setBody} onOpenChange={setCompleting} />
        <FormError error={add.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={add.isPending || !body.trim()} onClick={() => add.mutate(undefined)}>
            发表
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
