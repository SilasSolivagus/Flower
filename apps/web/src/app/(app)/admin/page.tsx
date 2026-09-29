'use client';

import { NoAccess } from '@/components/no-access';
import { PlainShell } from '@/components/plain-shell';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation, useInstanceSettings, useMe } from '@/lib/queries';

function Settings() {
  const q = useInstanceSettings();
  const save = useApiMutation((body: { allowSignup?: boolean; allowOrgCreation?: boolean }) => api('/instance/settings', { method: 'PATCH', body }), {
    invalidate: [qk.instance, qk.setup],
    success: '已保存',
  });
  if (!q.data) return null;
  const rows = [
    { key: 'allowSignup', label: '开放注册', hint: '关闭时只能通过邀请加入（默认）。', value: q.data.allowSignup },
    { key: 'allowOrgCreation', label: '允许用户自建组织', hint: '关闭时只有实例管理员可以创建组织。', value: q.data.allowOrgCreation },
  ] as const;
  return (
    <section className="flex flex-col divide-y rounded-lg border bg-card">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-4 px-4 py-3">
          <div className="flex flex-1 flex-col">
            <span className="font-medium">{r.label}</span>
            <span className="text-[13px] text-muted-foreground">{r.hint}</span>
          </div>
          <Switch aria-label={r.label} checked={r.value} onCheckedChange={(v) => save.mutate({ [r.key]: v })} />
        </div>
      ))}
    </section>
  );
}

export default function AdminPage() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <PlainShell>
      <h1 className="text-xl font-semibold">实例设置</h1>
      {me.data.account.isInstanceAdmin ? <Settings /> : <NoAccess message="只有实例管理员可以修改实例设置。" />}
    </PlainShell>
  );
}
