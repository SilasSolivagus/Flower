'use client';

import { SCHEDULE_SOURCE_LABELS } from '@flower/core/notifications';
import { CalendarClock } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { scheduleState } from '@/features/notifications/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useNotificationSchedules } from '@/lib/queries';
import type { NotificationSchedule, RunResult } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ScheduleDialog } from './schedule-dialog';

const STATE_LABEL = { alert: '告警', disabled: '已停用', normal: '正常' } as const;

/** 定时推送列表：给了 productId 只列本产品（产品设置页），否则列出全部并显示产品列（组织设置页）。 */
export function ScheduleList({ org, productId }: { org: string; productId?: string }) {
  const q = useNotificationSchedules(org, productId);
  const [open, setOpen] = useState<{ schedule: NotificationSchedule | null } | null>(null);
  const run = useApiMutation((id: string) => api<{ result: RunResult }>(`/orgs/${org}/notification-schedules/${id}/run`, { method: 'POST' }), {
    invalidate: [notifyKeys(org)],
    onSuccess: ({ result }) => {
      if (result.skipped) toast.info(`没有生成消息：${result.skipped}`);
      else toast.success(`已生成 ${result.deliveries} 条待发记录，几秒内发送${result.imageSkipped ? `；看板图片未发送：${result.imageSkipped}` : ''}`);
    },
  });
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/notification-schedules/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '定时推送已删除' });
  if (q.isError) return <LoadError message="加载定时推送失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">到点后生成内容并发到所选通道；连续失败达到阈值时标红告警。</p>
        <Button onClick={() => setOpen({ schedule: null })}>新建定时推送</Button>
      </div>
      {q.data.length === 0 ? (
        <EmptyState icon={CalendarClock} title="还没有定时推送" description="例如工作日 19:00 推送概览卡片，每天 9:30 推送新需求。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                {!productId && <TableHead>产品</TableHead>}
                <TableHead>内容</TableHead>
                <TableHead>定时</TableHead>
                <TableHead>下次执行</TableHead>
                <TableHead>通道</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-52" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((s) => {
                const state = scheduleState(s);
                return (
                  <TableRow key={s.id} className={cn('h-10 even:bg-zebra', state === 'alert' && 'bg-destructive/5 even:bg-destructive/5')}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    {!productId && <TableCell>{s.product?.name ?? '—'}</TableCell>}
                    <TableCell>{SCHEDULE_SOURCE_LABELS[s.source]}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {s.cron}
                      <span className="ml-1 text-muted-foreground">{s.timezone}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{s.nextRunAt ? formatDateTime(s.nextRunAt) : '—'}</TableCell>
                    <TableCell className="text-[13px]">{s.channels.map((c) => (c.enabled ? c.name : `${c.name}（已停用）`)).join('、') || '—'}</TableCell>
                    <TableCell className={cn('text-[13px]', state === 'alert' && 'font-medium text-destructive')} title={s.lastError ?? undefined}>
                      {STATE_LABEL[state]}
                      {state === 'alert' && ` · 连续失败 ${s.consecutiveFailures} 次`}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <ConfirmAction
                        trigger={
                          <Button variant="ghost" size="sm" disabled={run.isPending}>
                            立即执行
                          </Button>
                        }
                        title={`立即执行「${s.name}」？`}
                        description="会生成内容并向所选通道真实发送，结果见发送记录。"
                        confirmLabel="执行"
                        onConfirm={() => run.mutate(s.id)}
                      />
                      <Button variant="ghost" size="sm" onClick={() => setOpen({ schedule: s })}>
                        修改
                      </Button>
                      <ConfirmAction
                        trigger={
                          <Button variant="ghost" size="sm">
                            删除
                          </Button>
                        }
                        title={`删除定时推送「${s.name}」？`}
                        description="已有发送记录或被摘要规则使用的定时推送只能停用。"
                        confirmLabel="确认删除"
                        destructive
                        onConfirm={() => remove.mutate(s.id)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {open && <ScheduleDialog key={open.schedule?.id ?? 'new'} org={org} productId={productId} schedule={open.schedule} onClose={() => setOpen(null)} />}
    </section>
  );
}
