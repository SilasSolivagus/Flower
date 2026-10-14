'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/features/requirements/format';
import { PauseDialog } from '@/features/tracking/components/pause-dialog';
import { api } from '@/lib/api';
import { qk, requirementKeys, trackingKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

/** 需求详情侧栏「跟进」：加入 / 移出跟进、预计上线日期、暂停（填原因）/ 恢复。产品编辑及以上可以修改。 */
export function TrackingPanel({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const t = r.tracking;
  const canEdit = r.myRole !== 'viewer';
  const category = r.workflow.states.find((s) => s.key === r.stateKey)?.category ?? 'backlog';
  const closed = category === 'completed' || category === 'canceled';
  const [pausing, setPausing] = useState(false);
  const invalidate = [requirementKeys(org), trackingKeys(org), qk.workbench];
  const base = `/orgs/${org}/requirements/${r.id}`;
  const join = useApiMutation(() => api(`${base}/tracking`, { method: 'PUT', body: { tracking: true } }), { invalidate, success: '已加入跟进' });
  const leave = useApiMutation(() => api(`${base}/tracking`, { method: 'PUT', body: { tracking: false } }), { invalidate, success: '已移出跟进' });
  const date = useApiMutation((expectedDate: string | null) => api(`${base}/expected-date`, { method: 'PUT', body: { expectedDate } }), { invalidate, success: '已保存' });
  const resume = useApiMutation(() => api(`${base}/resume`, { method: 'POST' }), { invalidate, success: '已恢复' });
  const status = t.active
    ? `跟进中（${formatDate(t.trackedSince!)} 起）`
    : t.optedOut
      ? '已移出跟进'
      : t.trackedSince
        ? '已上线或已取消，不再显示为在手'
        : '未加入跟进';

  return (
    <section className="rounded-md border bg-card p-4 text-[13px]" aria-labelledby="tracking-title">
      <h2 id="tracking-title" className="mb-2 text-sm font-semibold">
        跟进
      </h2>
      <p>{status}</p>
      {t.paused && (
        <p className="mt-1 text-amber-800 dark:text-amber-300">
          已暂停：{t.paused.reason}（{formatDate(t.paused.at)} 起）
        </p>
      )}
      <div className="mt-3 flex flex-col gap-1.5">
        <Label htmlFor="tracking-expected">预计上线日期</Label>
        <Input
          id="tracking-expected"
          key={t.expectedDate ?? ''}
          type="date"
          className="h-8 w-44"
          defaultValue={t.expectedDate ?? ''}
          disabled={!canEdit || date.isPending}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (t.expectedDate ?? '')) date.mutate(v || null);
          }}
        />
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!t.active && !closed && (
            <Button size="sm" variant="outline" disabled={join.isPending} onClick={() => join.mutate(undefined)}>
              加入跟进
            </Button>
          )}
          {t.active && (
            <ConfirmAction
              trigger={
                <Button size="sm" variant="outline">
                  移出跟进
                </Button>
              }
              title="移出跟进？"
              description="移出后不再显示在跟进列表里，之后状态变化也不会自动加入；可以随时手动加入。"
              confirmLabel="移出"
              onConfirm={() => leave.mutate(undefined)}
            />
          )}
          {t.active && !t.paused && (
            <Button size="sm" variant="outline" onClick={() => setPausing(true)}>
              暂停
            </Button>
          )}
          {t.paused && (
            <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate(undefined)}>
              恢复
            </Button>
          )}
        </div>
      )}
      <PauseDialog open={pausing} onOpenChange={setPausing} path={base} invalidate={invalidate} />
    </section>
  );
}
