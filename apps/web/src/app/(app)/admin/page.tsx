'use client';

import { useRef, useState } from 'react';
import { LoadingBlock, QueryError } from '@/components/load-error';
import { NoAccess } from '@/components/no-access';
import { PlainShell } from '@/components/plain-shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation, useInstanceSettings, useMe } from '@/lib/queries';

const ROWS = [
  {
    key: 'allowSignup',
    label: '开放注册',
    hint: '关闭时只能通过邀请加入（默认）。',
    enable: '开启后，任何人都可以在登录页自行注册账号，不必等邀请。这会影响整个实例。',
    disable: '关闭后，登录页不再接受自行注册，新用户只能通过邀请加入。已经注册的账号可以继续登录。这会影响整个实例。',
  },
  {
    key: 'allowOrgCreation',
    label: '允许用户自建组织',
    hint: '关闭时只有实例管理员可以创建组织。',
    enable: '开启后，任何已登录用户都可以自己创建组织。这会影响整个实例。',
    disable: '关闭后，只有实例管理员可以创建组织。已经存在的组织不受影响。这会影响整个实例。',
  },
] as const;

type SettingKey = (typeof ROWS)[number]['key'];

function Settings() {
  const q = useInstanceSettings();
  const save = useApiMutation((body: { allowSignup?: boolean; allowOrgCreation?: boolean }) => api('/instance/settings', { method: 'PATCH', body }), {
    invalidate: [qk.instance, qk.setup],
    success: '已保存',
  });
  const [pending, setPending] = useState<{ key: SettingKey; next: boolean } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (q.isError) return <QueryError error={q.error} noAccessMessage="只有实例管理员可以查看实例设置。" retryMessage="加载实例设置失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingBlock />;
  const row = pending ? ROWS.find((r) => r.key === pending.key) : null;
  const confirm = () => {
    if (!pending) return;
    const body = { [pending.key]: pending.next };
    setPending(null);
    save.mutate(body);
  };
  return (
    <>
      <section className="flex flex-col divide-y rounded-lg border bg-card">
        {ROWS.map((r) => (
          <div key={r.key} className="flex items-center gap-4 px-4 py-3">
            <div className="flex flex-1 flex-col">
              <span className="font-medium">{r.label}</span>
              <span className="text-[13px] text-muted-foreground">{r.hint}</span>
            </div>
            <Switch aria-label={r.label} checked={q.data[r.key]} disabled={save.isPending} onCheckedChange={(v) => setPending({ key: r.key, next: v })} />
          </div>
        ))}
      </section>
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{pending?.next ? `开启${row?.label}` : `关闭${row?.label}`}</DialogTitle>
            <DialogDescription>{pending?.next ? row?.enable : row?.disable}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={cancelRef} variant="outline" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button onClick={confirm}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminPage() {
  const me = useMe();
  if (!me.data) return <LoadingBlock className="h-6 w-40" />;
  return (
    <PlainShell>
      {me.data.account.isInstanceAdmin ? (
        <>
          <h1 className="text-xl font-semibold">实例设置</h1>
          <Settings />
        </>
      ) : (
        <NoAccess message="只有实例管理员可以修改实例设置。" />
      )}
    </PlainShell>
  );
}
