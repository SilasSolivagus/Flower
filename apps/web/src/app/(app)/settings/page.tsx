'use client';

import { useTheme } from 'next-themes';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { FormError } from '@/components/form-error';
import { IssueTokenDialog } from '@/components/issue-token-dialog';
import { PlainShell } from '@/components/plain-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeScope, tokenStatus } from '@/features/tokens/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useMe, useOrg, useProducts, useTokens } from '@/lib/queries';

function PersonalTokens({ org }: { org: string }) {
  const orgQ = useOrg(org);
  const tokens = useTokens(org);
  const products = useProducts(org);
  const [issuing, setIssuing] = useState(false);
  const revoke = useApiMutation((id: string) => api(`/orgs/${org}/tokens/${id}`, { method: 'DELETE' }), { invalidate: [qk.tokens(org)], success: 'Token 已撤销' });
  const memberId = orgQ.data?.me.memberId;
  const mine = (tokens.data ?? []).filter((t) => t.memberId === memberId);
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>范围</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {mine.map((t) => (
              <TableRow key={t.id} className="h-10 even:bg-zebra">
                <TableCell>{t.name}</TableCell>
                <TableCell className="text-[13px]">{describeScope(t.scope, products.data ?? [])}</TableCell>
                <TableCell>{{ active: '有效', revoked: '已撤销', expired: '已过期' }[tokenStatus(t)]}</TableCell>
                <TableCell className="text-right">
                  {tokenStatus(t) === 'active' && (
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          撤销
                        </Button>
                      }
                      title={`撤销「${t.name}」？`}
                      description="撤销后使用这个 Token 的调用会立即失败。"
                      confirmLabel="确认撤销"
                      destructive
                      onConfirm={() => revoke.mutate(t.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {memberId && (
        <>
          <Button variant="outline" className="self-start" onClick={() => setIssuing(true)}>
            签发个人 Token
          </Button>
          <IssueTokenDialog org={org} open={issuing} onOpenChange={setIssuing} memberId={memberId} />
        </>
      )}
    </div>
  );
}

export default function PersonalSettingsPage() {
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [org, setOrg] = useState<string>('');
  const [synced, setSynced] = useState<typeof me.data>(undefined);
  if (me.data && me.data !== synced) {
    setSynced(me.data);
    setName(me.data.account.name);
    setOrg(org || me.data.orgs[0]?.slug || '');
  }
  const profile = useApiMutation((body: { name?: string; preferences?: { theme: 'light' | 'dark' | 'system' } }) => api('/me', { method: 'PATCH', body }), {
    invalidate: [qk.me],
    success: '已保存',
  });
  const password = useApiMutation(() => api('/me/password', { method: 'POST', body: { currentPassword: pw.current, newPassword: pw.next } }), {
    silentError: true,
    success: '密码已修改，其他设备上的登录已退出',
    onSuccess: () => setPw({ current: '', next: '', confirm: '' }),
  });
  if (!me.data) return null;
  return (
    <PlainShell>
      <h1 className="text-xl font-semibold">个人设置</h1>
      <section className="flex flex-col gap-4 rounded-lg border bg-card p-4">
        <h2 className="font-semibold">资料</h2>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="me-name">姓名</Label>
          <Input id="me-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label>邮箱</Label>
          <Input value={me.data.account.email} readOnly className="font-mono" />
        </div>
        <Button className="self-start" onClick={() => profile.mutate({ name })} disabled={profile.isPending}>
          保存资料
        </Button>
      </section>
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 className="font-semibold">主题</h2>
        <Select
          value={theme ?? 'light'}
          onValueChange={(v) => {
            setTheme(v);
            profile.mutate({ preferences: { theme: v as 'light' | 'dark' | 'system' } });
          }}
        >
          <SelectTrigger className="w-40" aria-label="主题">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">浅色</SelectItem>
            <SelectItem value="dark">深色</SelectItem>
            <SelectItem value="system">跟随系统</SelectItem>
          </SelectContent>
        </Select>
      </section>
      <form
        className="flex flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw.next !== pw.confirm) return setPwError('两次输入的新密码不一致');
          setPwError(null);
          password.mutate(undefined);
        }}
      >
        <h2 className="font-semibold">修改密码</h2>
        {(
          [
            ['current', '当前密码'],
            ['next', '新密码'],
            ['confirm', '确认新密码'],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="flex max-w-md flex-col gap-1.5">
            <Label htmlFor={`pw-${k}`}>{label}</Label>
            <Input id={`pw-${k}`} type="password" required value={pw[k]} onChange={(e) => setPw({ ...pw, [k]: e.target.value })} />
          </div>
        ))}
        {pwError && (
          <p role="alert" className="text-sm text-destructive">
            {pwError}
          </p>
        )}
        <FormError error={password.error} />
        <p className="text-xs text-muted-foreground">修改后，其他设备上的登录会被退出。</p>
        <Button type="submit" className="self-start" disabled={password.isPending}>
          修改密码
        </Button>
      </form>
      {me.data.orgs.length > 0 && (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <h2 className="flex-1 font-semibold">个人 Token</h2>
            <Select value={org} onValueChange={setOrg}>
              <SelectTrigger className="w-48" aria-label="Token 所属组织">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {me.data.orgs.map((o) => (
                  <SelectItem key={o.id} value={o.slug}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[13px] text-muted-foreground">个人 Token 以你的身份调用 API，权限不超过你本人。每个 Token 只属于一个组织。</p>
          {org && <PersonalTokens key={org} org={org} />}
        </section>
      )}
    </PlainShell>
  );
}
