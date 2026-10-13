'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation, useNotificationChannels, usePersonalEmailChannel } from '@/lib/queries';

const NONE = 'none';

/** 组织的个人通知邮件通道：成员在个人设置里开启邮件提醒后，经这个通道发到成员自己的邮箱。 */
export function PersonalEmailChannel({ org }: { org: string }) {
  const channels = useNotificationChannels(org);
  const current = usePersonalEmailChannel(org);
  const save = useApiMutation((channelId: string | null) => api(`/orgs/${org}/personal-email-channel`, { method: 'PUT', body: { channelId } }), {
    invalidate: [qk.personalEmailChannel(org)],
    success: '已保存',
  });
  if (!channels.data || !current.data) return null;
  const options = channels.data.filter((c) => c.kind === 'email' && c.enabled);
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">个人通知邮件通道</span>
        <span className="text-[12px] text-muted-foreground">成员在个人设置里开启邮件提醒后，经这个通道发到成员自己的邮箱。</span>
      </div>
      <Select value={current.data.channelId ?? NONE} onValueChange={(v) => save.mutate(v === NONE ? null : v)}>
        <SelectTrigger className="w-56" aria-label="个人通知邮件通道">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>不发邮件</SelectItem>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
