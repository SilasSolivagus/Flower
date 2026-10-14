'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDateTime } from '@/features/requirements/format';
import type { ProgressTarget } from '@/features/tracking/model';
import { api } from '@/lib/api';
import { qk, trackingKeys, useApiMutation, useMembers, useOrg, useProgress } from '@/lib/queries';
import type { ProgressEntry } from '@/lib/types';
import { WriteProgressDialog } from './progress-dialog';

function EditForm({ org, entry, onDone }: { org: string; entry: ProgressEntry; onDone: () => void }) {
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [body, setBody] = useState(entry.body);
  const [nextStep, setNextStep] = useState(entry.nextStep ?? '');
  const [follower, setFollower] = useState<string | null>(entry.follower?.id ?? null);
  const save = useApiMutation(
    () => api(`/orgs/${org}/progress/${entry.id}`, { method: 'PATCH', body: { body: body.trim(), nextStep: nextStep.trim() || null, followerMemberId: follower } }),
    { invalidate: [trackingKeys(org), qk.workbench], silentError: true, success: '已保存', onSuccess: onDone },
  );
  const people = activePeople(members.data ?? []);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <Textarea aria-label="修改进展" maxLength={2000} className="min-h-20 text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="修改下一步" placeholder="下一步" maxLength={500} className="h-8 min-w-0 flex-1" value={nextStep} onChange={(e) => setNextStep(e.target.value)} />
        {people.length > 0 && (
          <MemberPicker label="修改跟进人" className="h-8 w-36" noneLabel="不指定" options={pickerOptions(people, entry.follower)} value={follower} onChange={setFollower} />
        )}
      </div>
      <FormError error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={!body.trim() || save.isPending}>
          保存
        </Button>
      </div>
    </form>
  );
}

/** 进展记录：时间倒序；能写的人可以新增；作者本人可以修改；作者与管理员可以删除。需求详情与工作项详情共用。 */
export function ProgressList({ org, target, canWrite }: { org: string; target: ProgressTarget; canWrite: boolean }) {
  const q = useProgress(org, target.type, target.id);
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/progress/${id}`, { method: 'DELETE' }), { invalidate: [trackingKeys(org), qk.workbench], success: '已删除' });
  const entries = q.data ?? [];

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="progress-title">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="progress-title" className="text-sm font-semibold">
          进展记录 <span className="font-mono text-xs text-muted-foreground">{entries.length}</span>
        </h2>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setWriting(true)}>
            写进展
          </Button>
        )}
      </div>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="无法读取进展记录。" retryMessage="加载进展记录失败，请重试。" onRetry={() => q.refetch()} />
      ) : entries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有进展记录</p>
      ) : (
        <ul aria-label="进展记录列表" className="flex flex-col gap-3">
          {entries.map((p) => (
            <li key={p.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                <span className="font-medium text-foreground">{p.author?.displayName ?? '未知成员'}</span>
                <span>{formatDateTime(p.createdAt)}</span>
                {p.editedAt && <span>（已编辑）</span>}
                <span className="flex-1" />
                {p.canEdit && editing !== p.id && (
                  <button type="button" className="text-primary" onClick={() => setEditing(p.id)}>
                    修改
                  </button>
                )}
                {p.canDelete && (
                  <ConfirmAction
                    trigger={
                      <button type="button" className="text-destructive">
                        删除
                      </button>
                    }
                    title="删除这条进展？"
                    description="删除后不再显示在进展记录与跟进列表里。"
                    confirmLabel="删除"
                    destructive
                    onConfirm={() => remove.mutate(p.id)}
                  />
                )}
              </div>
              {editing === p.id ? (
                <EditForm org={org} entry={p} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-6">{p.body}</p>
                  {(p.nextStep || p.follower) && (
                    <p className="text-[13px] text-muted-foreground">
                      下一步：{p.nextStep ?? '—'}
                      {p.follower && ` · 跟进人：${p.follower.displayName}`}
                    </p>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <WriteProgressDialog org={org} target={writing ? target : null} defaultFollower={null} onOpenChange={setWriting} onSaved={() => undefined} />
    </section>
  );
}
