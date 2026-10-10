'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CHANGE_TYPE_LABEL, MERGE_STATUS_LABEL } from '@/features/documents/model';
import { ApiError, api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { MergeItem, MergeResult } from '@/lib/types';

/**
 * 合入页的一个功能点：左侧模块文档现状，右侧可编辑的合入内容（用户改过之前跟随服务端预填），应用 / 跳过 / 撤销跳过。
 * baseVersion 是本页看到的模块文档版本号（文档还不存在时为 null），模块文档有更新的版本时服务端返回 409。
 */
export function MergeItemCard({
  org,
  documentId,
  baseVersion,
  item,
  canMerge,
  canReopen,
  onRefresh,
}: {
  org: string;
  documentId: string;
  baseVersion: number | null;
  item: MergeItem;
  canMerge: boolean;
  canReopen: boolean;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const body = draft ?? item.prefill;
  const invalidate = [documentKeys(org), requirementKeys(org), qk.workbench];
  const path = `/orgs/${org}/documents/${documentId}/merge/${item.nodeId}`;
  const apply = useApiMutation(() => api<{ result: MergeResult }>(`${path}/apply`, { method: 'POST', body: { baseVersion, body } }), { silentError: true, invalidate, success: '已应用' });
  const skip = useApiMutation(() => api<{ result: MergeResult }>(`${path}/skip`, { method: 'POST' }), { silentError: true, invalidate, success: '已跳过' });
  const reopen = useApiMutation(() => api<{ result: MergeResult }>(`${path}/reopen`, { method: 'POST' }), { silentError: true, invalidate, success: '已撤销跳过' });
  const error = apply.error ?? skip.error ?? reopen.error;
  const conflict = apply.error instanceof ApiError && apply.error.status === 409;
  const busy = apply.isPending || skip.isPending || reopen.isPending;
  const pending = item.mergeStatus === 'pending';
  const removing = item.changeType === 'removed';
  const stale = item.sourceSections.filter((s) => s.stale);
  const actions = (pending && canMerge) || (item.mergeStatus === 'skipped' && canReopen);
  return (
    <article aria-label={item.path} className="min-w-0 rounded-md border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[13px]">
        <span className="font-medium">{item.name}</span>
        <span className="rounded-sm bg-muted px-1.5 text-xs">{CHANGE_TYPE_LABEL[item.changeType]}</span>
        <span className="text-muted-foreground">
          {MERGE_STATUS_LABEL[item.mergeStatus]}
          {item.mergeStatus === 'applied' && item.mergedRevisionNumber !== null && ` · 第 ${item.mergedRevisionNumber} 版`}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">模块文档现状</h3>
          {item.current === null ? (
            <p className="text-[13px] text-muted-foreground">{item.changeType === 'modified' && pending ? '模块文档里没有这个小节，应用时按新增处理' : '模块文档里还没有这个小节'}</p>
          ) : (
            <pre aria-label={`${item.name} 现状`} className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-[12px]">
              {item.current || '（空）'}
            </pre>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">合入内容</h3>
          {removing ? (
            <p className="text-[13px]">应用后将删除该小节</p>
          ) : (
            <Textarea
              aria-label={`${item.name} 合入内容`}
              className="min-h-40 font-mono text-[12px]"
              value={body}
              readOnly={!pending || !canMerge}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          {stale.length > 0 && <p className="text-xs text-muted-foreground">来源小节已失效，未预填：{stale.map((s) => s.key).join('、')}</p>}
        </div>
      </div>
      {(error || actions) && (
        <footer className="flex flex-col gap-2 border-t px-4 py-2">
          <FormError error={error} />
          <div className="flex flex-wrap gap-2">
            {conflict && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  apply.reset();
                  onRefresh();
                }}
              >
                刷新左侧
              </Button>
            )}
            {pending && canMerge && (
              <>
                <Button size="sm" disabled={busy} aria-label={`应用 ${item.name}`} onClick={() => apply.mutate()}>
                  应用
                </Button>
                <Button size="sm" variant="outline" disabled={busy} aria-label={`跳过 ${item.name}`} onClick={() => skip.mutate()}>
                  跳过
                </Button>
              </>
            )}
            {item.mergeStatus === 'skipped' && canReopen && (
              <Button size="sm" variant="outline" disabled={busy} aria-label={`撤销跳过 ${item.name}`} onClick={() => reopen.mutate()}>
                撤销跳过
              </Button>
            )}
          </div>
        </footer>
      )}
    </article>
  );
}
