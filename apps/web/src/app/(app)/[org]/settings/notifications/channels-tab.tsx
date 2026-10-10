'use client';

import { CHANNEL_KIND_LABELS } from '@flower/core/notifications';
import { Radio } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useNotificationChannels, useProducts } from '@/lib/queries';
import type { NotificationChannel, NotificationDelivery } from '@/lib/types';
import { ChannelDialog } from './channel-dialog';

export function ChannelsTab({ org }: { org: string }) {
  const q = useNotificationChannels(org);
  const products = useProducts(org);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);
  const productName = new Map((products.data ?? []).map((p) => [p.id, p.name]));
  const toggleEnabled = useApiMutation(
    (v: { id: string; enabled: boolean }) => api(`/orgs/${org}/notification-channels/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }),
    { invalidate: [notifyKeys(org)], success: '已保存' },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/notification-channels/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '通道已删除' });
  const test = useApiMutation((id: string) => api<{ delivery: NotificationDelivery }>(`/orgs/${org}/notification-channels/${id}/test`, { method: 'POST' }), {
    invalidate: [notifyKeys(org)],
    onSuccess: ({ delivery }) => {
      if (delivery.status === 'sent') toast.success('测试消息已发送');
      else toast.error(`测试消息发送失败：${delivery.response ?? '未知原因'}`);
    },
  });
  if (q.isError) return <LoadError message="加载通道失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">一个通道对应一个机器人或地址；同一个群的多个机器人用「所属群」归组。迁移来的通道默认停用。</p>
        <Button onClick={() => setCreating(true)}>登记通道</Button>
      </div>
      {q.data.length === 0 ? (
        <EmptyState icon={Radio} title="还没有通道" description="登记企业微信机器人、Webhook 或邮件后，才能配置事件规则与定时推送。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>地址</TableHead>
                <TableHead>可用产品</TableHead>
                <TableHead className="w-24">每分钟上限</TableHead>
                <TableHead className="w-16">启用</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((c) => (
                <TableRow key={c.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-medium">
                    {c.name}
                    {c.groupLabel && <span className="ml-2 text-xs text-muted-foreground">{c.groupLabel}</span>}
                  </TableCell>
                  <TableCell>{CHANNEL_KIND_LABELS[c.kind]}</TableCell>
                  <TableCell className="font-mono text-xs">{c.configHint}</TableCell>
                  <TableCell className="text-[13px]">{c.allowedProductIds.length ? c.allowedProductIds.map((id) => productName.get(id) ?? '已删除的产品').join('、') : '全部产品'}</TableCell>
                  <TableCell className="font-mono text-xs">{c.rateLimitPerMin}</TableCell>
                  <TableCell>
                    <Switch aria-label={`启用${c.name}`} checked={c.enabled} onCheckedChange={(v) => toggleEnabled.mutate({ id: c.id, enabled: v })} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm" disabled={!c.enabled || test.isPending} title={c.enabled ? undefined : '启用后才能发送测试消息'}>
                          测试
                        </Button>
                      }
                      title={`向「${c.name}」发送测试消息？`}
                      description="会向该群或地址真实发送一条固定内容的消息，结果写入发送记录。"
                      confirmLabel="发送"
                      onConfirm={() => test.mutate(c.id)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                      修改
                    </Button>
                    {c.usage.rules + c.usage.schedules + c.usage.deliveries === 0 && (
                      <ConfirmAction
                        trigger={
                          <Button variant="ghost" size="sm">
                            删除
                          </Button>
                        }
                        title={`删除通道「${c.name}」？`}
                        description="删除后不能恢复。已有发送记录或被规则、定时推送引用的通道只能停用。"
                        confirmLabel="确认删除"
                        destructive
                        onConfirm={() => remove.mutate(c.id)}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {creating && <ChannelDialog org={org} channel={null} open onOpenChange={setCreating} />}
      {editing && <ChannelDialog key={editing.id} org={org} channel={editing} open onOpenChange={(v) => !v && setEditing(null)} />}
    </section>
  );
}
