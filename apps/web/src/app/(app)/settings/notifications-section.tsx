'use client';

import {
  MEMBER_NOTIFICATION_KIND_LABELS,
  type MemberNotificationKind,
  NOTIFICATION_PREF_CHANNEL_LABELS,
  type NotificationPref,
  type NotificationPrefChannel,
} from '@flower/core/notifications';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { prefCell } from '@/features/member-notifications/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useNotificationSettings } from '@/lib/queries';

const CHANNELS: NotificationPrefChannel[] = ['inApp', 'wecom', 'email'];

/** 个人设置里某个组织的通知：偏好表（行为通知类型，列为站内、企业微信、邮件）与企业微信绑定。 */
export function PersonalNotifications({ org }: { org: string }) {
  const q = useNotificationSettings(org);
  const save = useApiMutation(
    (v: { kind: MemberNotificationKind; pref: NotificationPref }) => api(`/orgs/${org}/me/notification-prefs/${v.kind}`, { method: 'PUT', body: v.pref }),
    { invalidate: [qk.notificationSettings(org)], success: '已保存' },
  );
  const bind = useApiMutation(() => api<{ url: string }>(`/orgs/${org}/me/wecom/bind`, { method: 'POST' }), {
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const unbind = useApiMutation(() => api(`/orgs/${org}/me/wecom`, { method: 'DELETE' }), { invalidate: [qk.notificationSettings(org)], success: '已解除企业微信绑定' });
  if (q.isError) return <LoadError message="加载通知设置失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  const s = q.data;
  const cells = { inApp: prefCell(s, 'inApp'), wecom: prefCell(s, 'wecom'), email: prefCell(s, 'email') };
  const notes = (['wecom', 'email'] as const).flatMap((c) => (cells[c].reason ? [`${NOTIFICATION_PREF_CHANNEL_LABELS[c]}：${cells[c].reason}`] : []));
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>通知类型</TableHead>
              {CHANNELS.map((c) => (
                <TableHead key={c} className="w-24 text-center">
                  {NOTIFICATION_PREF_CHANNEL_LABELS[c]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.prefs.map((p) => (
              <TableRow key={p.kind} className="h-10 even:bg-zebra">
                <TableCell>{MEMBER_NOTIFICATION_KIND_LABELS[p.kind]}</TableCell>
                {CHANNELS.map((c) => (
                  <TableCell key={c} className="text-center">
                    <Switch
                      aria-label={`${MEMBER_NOTIFICATION_KIND_LABELS[p.kind]} · ${NOTIFICATION_PREF_CHANNEL_LABELS[c]}`}
                      checked={p[c]}
                      disabled={cells[c].disabled || save.isPending}
                      onCheckedChange={(v) => {
                        const pref: NotificationPref = { inApp: p.inApp, wecom: p.wecom, email: p.email };
                        pref[c] = v;
                        save.mutate({ kind: p.kind, pref });
                      }}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {notes.map((n) => (
        <p key={n} className="text-[13px] text-muted-foreground">
          {n}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
        <span className="text-[13px]">
          企业微信账号：{s.wecom.userid ? <span className="font-mono">{s.wecom.userid}</span> : '未绑定'}
        </span>
        {s.wecom.userid ? (
          <ConfirmAction
            trigger={
              <Button variant="outline" size="sm">
                解除绑定
              </Button>
            }
            title="解除企业微信绑定？"
            description="解除后，群里的个人提醒不再 @ 到你；站内通知不受影响。"
            confirmLabel="解除绑定"
            destructive
            onConfirm={() => unbind.mutate(undefined)}
          />
        ) : (
          <Button size="sm" disabled={!s.wecom.bindEnabled || bind.isPending} onClick={() => bind.mutate(undefined)}>
            绑定企业微信
          </Button>
        )}
        {!s.wecom.userid && !s.wecom.bindEnabled && (
          <span className="text-[12px] text-muted-foreground">组织还没有开启扫码绑定，可以请组织管理员在「成员」里填写你的企业微信账号。</span>
        )}
      </div>
    </div>
  );
}
