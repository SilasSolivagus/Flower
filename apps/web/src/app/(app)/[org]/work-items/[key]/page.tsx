'use client';

import { useParams, useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { BlockerList } from '@/components/blocker-list';
import { ConfirmAction } from '@/components/confirm-action';
import { EditableTitle } from '@/components/editable-title';
import { FollowButton } from '@/components/follow-button';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { WikiText } from '@/components/wiki-text';
import { WikilinkTextarea } from '@/components/wikilink-textarea';
import { useMarkNotificationsRead } from '@/features/member-notifications/use-mark-read';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDate, formatDateTime } from '@/features/requirements/format';
import { PauseDialog } from '@/features/tracking/components/pause-dialog';
import { ProgressList } from '@/features/tracking/components/progress-list';
import { WORK_ITEM_STATUS_LABELS } from '@/features/tracking/model';
import { api } from '@/lib/api';
import { qk, trackingKeys, useApiMutation, useFields, useMembers, useOrg, useProducts, useWorkItem } from '@/lib/queries';
import type { WorkItemDetail } from '@/lib/types';

const NONE = '__none';
const WORK_ITEM_REQUIREMENT_NOTE = '工作项不关联需求；请从需求详情看关联';
type Patch = { title?: string; description?: string; productId?: string | null; ownerMemberId?: string | null; workTypeOptionId?: string | null; startedOn?: string | null; expectedDate?: string | null };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function InfoPanel({ org, item: w }: { org: string; item: WorkItemDetail }) {
  const router = useRouter();
  const orgQ = useOrg(org);
  const edit = w.access.edit;
  const canList = canListMembers(orgQ.data?.me);
  const members = useMembers(org, edit && canList);
  const fields = useFields(org, undefined, edit && canList);
  const products = useProducts(org);
  const [pausing, setPausing] = useState(false);
  const invalidate = [trackingKeys(org), qk.workbench];
  const base = `/orgs/${org}/work-items/${w.id}`;
  const patch = useApiMutation((body: Patch) => api(base, { method: 'PATCH', body }), { invalidate, success: '已保存' });
  const status = useApiMutation((to: string) => api(`${base}/status`, { method: 'POST', body: { status: to } }), { invalidate, success: '已更新状态' });
  const resume = useApiMutation(() => api(`${base}/resume`, { method: 'POST' }), { invalidate, success: '已恢复' });
  const remove = useApiMutation(() => api(base, { method: 'DELETE' }), { invalidate, success: '已删除', onSuccess: () => router.push(`/${org}/tracking`) });
  const workType = fields.data?.find((f) => f.key === 'work_type');
  const people = activePeople(members.data ?? []);
  const dateInput = (label: string, key: 'startedOn' | 'expectedDate') => (
    <Input
      key={w[key] ?? ''}
      type="date"
      aria-label={label}
      className="h-8 w-44"
      defaultValue={w[key] ?? ''}
      disabled={!edit || patch.isPending}
      onBlur={(e) => {
        const v = e.target.value;
        if (v !== (w[key] ?? '')) patch.mutate(key === 'startedOn' ? { startedOn: v || null } : { expectedDate: v || null });
      }}
    />
  );

  return (
    <section aria-labelledby="info-title" className="flex flex-col gap-3 rounded-md border bg-card p-4 text-[13px]">
      <h2 id="info-title" className="text-sm font-semibold">
        基本信息
      </h2>
      <Field label="状态">
        <Select value={w.status} onValueChange={(v) => status.mutate(v)} disabled={!edit || status.isPending}>
          <SelectTrigger className="h-8 w-32" aria-label="状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(WORK_ITEM_STATUS_LABELS) as Array<keyof typeof WORK_ITEM_STATUS_LABELS>).map((s) => (
              <SelectItem key={s} value={s}>
                {WORK_ITEM_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {w.paused ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-amber-800 dark:text-amber-300">
            已暂停：{w.paused.reason}（{formatDate(w.paused.at)} 起）
          </span>
          {edit && (
            <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate(undefined)}>
              恢复
            </Button>
          )}
        </div>
      ) : (
        edit &&
        w.status === 'active' && (
          <Button size="sm" variant="outline" className="self-start" onClick={() => setPausing(true)}>
            暂停
          </Button>
        )
      )}
      <Field label="工作类型">
        {edit && workType ? (
          <Select value={w.workType?.id ?? NONE} onValueChange={(v) => patch.mutate({ workTypeOptionId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8 w-36" aria-label="工作类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未设置</SelectItem>
              {workType.options
                .filter((o) => o.active || o.id === w.workType?.id)
                .map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <span>{w.workType?.label ?? '未设置'}</span>
        )}
      </Field>
      <Field label="负责人">
        {edit && people.length > 0 ? (
          <MemberPicker label="负责人" className="h-8 w-full" noneLabel="无负责人" options={pickerOptions(people, w.owner)} value={w.owner?.id ?? null} onChange={(id) => patch.mutate({ ownerMemberId: id })} />
        ) : (
          <span>{w.owner?.displayName ?? '无负责人'}</span>
        )}
      </Field>
      <Field label="关联产品">
        {edit ? (
          <Select value={w.product?.id ?? NONE} onValueChange={(v) => patch.mutate({ productId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8 w-40" aria-label="关联产品">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不关联产品</SelectItem>
              {(products.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
              {w.product && !(products.data ?? []).some((p) => p.id === w.product!.id) && <SelectItem value={w.product.id}>{w.product.name}</SelectItem>}
            </SelectContent>
          </Select>
        ) : (
          <span>{w.product?.name ?? '不关联产品'}</span>
        )}
      </Field>
      <p className="text-xs leading-5 text-muted-foreground">{WORK_ITEM_REQUIREMENT_NOTE}</p>
      <Field label="启动日期">{dateInput('启动日期', 'startedOn')}</Field>
      <Field label="预计完成日期">{dateInput('预计完成日期', 'expectedDate')}</Field>
      <p className="text-xs text-muted-foreground">
        {w.createdBy?.displayName ?? '未知成员'} 创建于 {formatDateTime(w.createdAt)}
        {w.doneAt && ` · ${formatDate(w.doneAt)} 完成`}
      </p>
      {edit && (
        <ConfirmAction
          trigger={
            <Button size="sm" variant="ghost" className="self-start text-destructive">
              删除工作项
            </Button>
          }
          title={`删除 ${w.displayKey}？`}
          description="删除后不再出现在跟进列表与工作台里。"
          confirmLabel="删除"
          destructive
          onConfirm={() => remove.mutate(undefined)}
        />
      )}
      <PauseDialog open={pausing} onOpenChange={setPausing} path={base} invalidate={invalidate} />
    </section>
  );
}

export default function WorkItemPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const q = useWorkItem(org, decodeURIComponent(key));
  const w = q.data;
  useMarkNotificationsRead(org, 'work_item', w?.id);
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState('');
  const patch = useApiMutation((body: Patch) => api(`/orgs/${org}/work-items/${w!.id}`, { method: 'PATCH', body }), {
    invalidate: [trackingKeys(org), qk.workbench],
    success: '已保存',
  });

  if (!w && q.isError) {
    return <QueryError error={q.error} noAccessMessage="工作项不存在，或你没有查看它的权限。" retryMessage="加载工作项失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!w) return <Skeleton className="h-64" />;

  return (
    <>
      <PageHeader
        crumbs={[{ label: '跟进', href: `/${org}/tracking` }, { label: w.displayKey }]}
        title={<EditableTitle displayKey={w.displayKey} title={w.title} canEdit={w.access.edit} onSubmit={(title, close) => patch.mutate({ title }, { onSuccess: close })} />}
        actions={<FollowButton org={org} type="work_item" id={w.id} />}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-md border bg-card p-4" aria-labelledby="desc-title">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="desc-title" className="text-sm font-semibold">
                描述
              </h2>
              {w.access.edit && !editingDesc && (
                <button
                  type="button"
                  className="text-[13px] text-primary"
                  onClick={() => {
                    setDescription(w.description);
                    setEditingDesc(true);
                  }}
                >
                  编辑
                </button>
              )}
            </div>
            {editingDesc ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  patch.mutate({ description }, { onSuccess: () => setEditingDesc(false) });
                }}
              >
                <WikilinkTextarea
                  org={org}
                  productId={w.product?.id ?? null}
                  links={false}
                  aria-label="描述"
                  className="min-h-32 text-[13px]"
                  value={description}
                  onValueChange={setDescription}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingDesc(false)}>
                    取消
                  </Button>
                  <Button type="submit" size="sm" disabled={patch.isPending}>
                    保存
                  </Button>
                </div>
              </form>
            ) : w.description ? (
              <WikiText org={org} text={w.description} cards={[]} productKey={w.product?.key ?? ''} productId={w.product?.id ?? null} links={false} className="text-[13px] leading-6" />
            ) : (
              <p className="text-[13px] leading-6 text-muted-foreground">暂无描述</p>
            )}
          </section>
          <ProgressList
            org={org}
            target={{ type: 'work_item', id: w.id, displayKey: w.displayKey, title: w.title, expectedDate: w.expectedDate, canEditDate: w.access.edit }}
            canWrite={w.access.progress}
          />
          <BlockerList org={org} blockers={w.blockers} canEdit={w.access.progress} addPath={`/orgs/${org}/work-items/${w.id}/blockers`} invalidate={[trackingKeys(org)]} />
        </div>
        <div className="flex flex-col gap-4">
          <InfoPanel org={org} item={w} />
        </div>
      </div>
    </>
  );
}
