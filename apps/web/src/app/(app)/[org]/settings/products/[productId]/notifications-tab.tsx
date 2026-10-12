'use client';

import { EVENT_TYPE_LABELS, type NotifiableEventType } from '@flower/core/notifications';
import { BellRing } from 'lucide-react';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type FilterLookups, filterSummary } from '@/features/notifications/model';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useFields, useNodes, useNotificationRules, useProductWorkflow } from '@/lib/queries';
import type { NotificationRule } from '@/lib/types';
import { ScheduleList } from '../../notifications/schedule-list';
import { RuleDialog } from './rule-dialog';

function RuleList({ org, productId }: { org: string; productId: string }) {
  const q = useNotificationRules(org, productId);
  const workflow = useProductWorkflow(org, productId);
  const fields = useFields(org, productId);
  const nodes = useNodes(org, productId);
  const [open, setOpen] = useState<{ rule: NotificationRule | null } | null>(null);
  const toggleEnabled = useApiMutation(
    (v: { id: string; enabled: boolean }) => api(`/orgs/${org}/notification-rules/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }),
    { invalidate: [notifyKeys(org)], success: '已保存' },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/notification-rules/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '规则已删除' });
  const lookups: FilterLookups = {
    states: new Map((workflow.data?.version.body.states ?? []).map((s) => [s.key, s.label])),
    priorities: new Map((fields.data?.find((f) => f.key === 'priority')?.options ?? []).map((o) => [o.key, o.label])),
    nodes: new Map((nodes.data ?? []).map((n) => [n.id, n.name])),
    fields: new Map((fields.data ?? []).map((f) => [f.key, f.label])),
  };
  if (q.isError) return <LoadError message="加载事件规则失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">事件规则</h2>
        <Button onClick={() => setOpen({ rule: null })}>新建规则</Button>
      </div>
      {q.data.length === 0 ? (
        <EmptyState icon={BellRing} title="还没有事件规则" description="例如：新建需求时推送到产品群；需求状态变化合并进每天的变更摘要。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>事件</TableHead>
                <TableHead>条件</TableHead>
                <TableHead>推送到</TableHead>
                <TableHead className="w-16">启用</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((r) => (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-[13px]">{r.eventTypes.map((t: NotifiableEventType) => EVENT_TYPE_LABELS[t]).join('、')}</TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">{filterSummary(r.filter, lookups)}</TableCell>
                  <TableCell className="text-[13px]">
                    {r.mode === 'digest' ? `变更摘要「${r.digestScheduleName ?? '—'}」` : r.channels.map((c) => (c.enabled ? c.name : `${c.name}（已停用）`)).join('、')}
                  </TableCell>
                  <TableCell>
                    <Switch aria-label={`启用${r.name}`} checked={r.enabled} onCheckedChange={(v) => toggleEnabled.mutate({ id: r.id, enabled: v })} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button variant="ghost" size="sm" onClick={() => setOpen({ rule: r })}>
                      修改
                    </Button>
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          删除
                        </Button>
                      }
                      title={`删除规则「${r.name}」？`}
                      description="已有发送记录的规则只能停用。"
                      confirmLabel="确认删除"
                      destructive
                      onConfirm={() => remove.mutate(r.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {open && <RuleDialog key={open.rule?.id ?? 'new'} org={org} productId={productId} rule={open.rule} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** 产品设置「推送」页签：本产品的事件规则与定时推送（产品管理员）。 */
export function NotificationsTab({ org, productId }: { org: string; productId: string }) {
  return (
    <div className="flex flex-col gap-8">
      <RuleList org={org} productId={productId} />
      <div className="flex flex-col gap-3">
        <h2 className="font-semibold">定时推送</h2>
        <ScheduleList org={org} productId={productId} />
      </div>
    </div>
  );
}
