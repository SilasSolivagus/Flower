'use client';

import { DELIVERY_KIND_LABELS, DELIVERY_KINDS, DELIVERY_STATUS_LABELS, DELIVERY_STATUSES } from '@flower/core/notifications';
import { Inbox } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DELIVERY_STATUS_TONE, type DeliveryFilter, deliveryApiQuery, deliveryUrlQuery, parseDeliveryFilter } from '@/features/notifications/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useNotificationChannels, useNotificationDeliveries } from '@/lib/queries';
import { cn } from '@/lib/utils';

const ALL = 'all';

export function DeliveriesTab({ org }: { org: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const filter = parseDeliveryFilter(useSearchParams());
  const [offset] = useState(() => new Date().getTimezoneOffset());
  const q = useNotificationDeliveries(org, deliveryApiQuery(filter, offset));
  const channels = useNotificationChannels(org);
  const resend = useApiMutation((id: string) => api(`/orgs/${org}/notification-deliveries/${id}/resend`, { method: 'POST' }), {
    invalidate: [notifyKeys(org)],
    success: '已加入发送队列',
  });
  /** 改筛选回到第一页；筛选与页签都写在地址栏。 */
  const update = (patch: Partial<DeliveryFilter>) => {
    const qs = deliveryUrlQuery({ ...filter, before: '', ...patch });
    router.replace(`${pathname}?tab=deliveries${qs ? `&${qs}` : ''}`);
  };
  const filtered = !!(filter.channel || filter.kind || filter.status || filter.from || filter.to);
  if (q.isError) return <LoadError message="加载发送记录失败，请重试。" onRetry={() => q.refetch()} />;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter.channel || ALL} onValueChange={(v) => update({ channel: v === ALL ? '' : v })}>
          <SelectTrigger className="w-40" aria-label="按通道筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部通道</SelectItem>
            {(channels.data ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.kind || ALL} onValueChange={(v) => update({ kind: v === ALL ? '' : (v as DeliveryFilter['kind']) })}>
          <SelectTrigger className="w-32" aria-label="按来源筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部来源</SelectItem>
            {DELIVERY_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {DELIVERY_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.status || ALL} onValueChange={(v) => update({ status: v === ALL ? '' : (v as DeliveryFilter['status']) })}>
          <SelectTrigger className="w-32" aria-label="按状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {DELIVERY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {DELIVERY_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" aria-label="起始日期" className="w-40" value={filter.from} onChange={(e) => update({ from: e.target.value })} />
        <span className="text-[13px] text-muted-foreground">至</span>
        <Input type="date" aria-label="结束日期" className="w-40" value={filter.to} onChange={(e) => update({ to: e.target.value })} />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => router.replace(`${pathname}?tab=deliveries`)}>
            清除筛选
          </Button>
        )}
      </div>
      {!q.data ? null : q.data.deliveries.length === 0 ? (
        <EmptyState icon={Inbox} title={filtered ? '没有符合条件的发送记录' : '还没有发送记录'} description="测试消息、事件规则与定时推送的每一次发送都会记在这里。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">时间</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>通道</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-12">次数</TableHead>
                <TableHead className="w-36">下次重试</TableHead>
                <TableHead>内容</TableHead>
                <TableHead>响应</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.deliveries.map((d) => (
                <TableRow key={d.id} className={cn('h-10 even:bg-zebra', d.source.alert && 'bg-destructive/5 even:bg-destructive/5')}>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{formatDateTime(d.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-[13px]">
                    {DELIVERY_KIND_LABELS[d.kind]}
                    {d.source.name && <span className="ml-1 font-medium">{d.source.name}</span>}
                    {d.source.alert && <span className="ml-1 text-xs font-medium text-destructive">告警</span>}
                    {d.legacy && <span className="ml-1 text-xs text-muted-foreground">迁移</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-[13px]">{d.channel.name}</TableCell>
                  <TableCell className={cn('whitespace-nowrap text-[13px]', DELIVERY_STATUS_TONE[d.status])}>{DELIVERY_STATUS_LABELS[d.status]}</TableCell>
                  <TableCell className="font-mono text-xs">{d.attempts}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{d.status === 'failed' && d.nextAttemptAt ? formatDateTime(d.nextAttemptAt) : '—'}</TableCell>
                  <TableCell className="max-w-[20rem] truncate text-[13px]" title={d.preview}>
                    {d.preview}
                  </TableCell>
                  <TableCell className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground" title={d.response ?? undefined}>
                    {d.response ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {d.canResend && (
                      <Button variant="ghost" size="sm" disabled={resend.isPending} onClick={() => resend.mutate(d.id)}>
                        重发
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {filter.before && (
          <Button variant="outline" size="sm" onClick={() => update({})}>
            回到最新
          </Button>
        )}
        {q.data?.nextCursor && (
          <Button variant="outline" size="sm" onClick={() => update({ before: q.data!.nextCursor! })}>
            下一页
          </Button>
        )}
      </div>
    </section>
  );
}
