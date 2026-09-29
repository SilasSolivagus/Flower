'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation, useMe } from '@/lib/queries';
import type { InvitationPreview } from '@/lib/types';

const STATUS_TEXT = { expired: '邀请已过期，请联系管理员重新发送。', accepted: '这个邀请已经被接受。', revoked: '邀请已被撤销。' } as const;

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api<InvitationPreview>(`/invitations/${token}`) });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const accept = useApiMutation(
    (body: { name?: string; password?: string }) => api<{ orgSlug: string }>(`/invitations/${token}/accept`, { method: 'POST', body }),
    {
      silentError: true,
      onSuccess: async (d) => {
        await qc.invalidateQueries({ queryKey: qk.me });
        router.replace(`/${d.orgSlug}`);
      },
    },
  );
  const p = preview.data;
  let body: React.ReactNode = null;
  if (preview.isError) body = <p className="text-muted-foreground">邀请不存在，请确认链接是否完整。</p>;
  else if (p && p.status !== 'pending') body = <p className="text-muted-foreground">{STATUS_TEXT[p.status]}</p>;
  else if (p && me.data) {
    body =
      me.data.account.email === p.email ? (
        <Button onClick={() => accept.mutate({})} disabled={accept.isPending}>
          以 {me.data.account.name} 的身份加入
        </Button>
      ) : (
        <p className="text-muted-foreground">
          这个邀请发给了 <span className="font-mono">{p.email}</span>，而你当前登录的是 <span className="font-mono">{me.data.account.email}</span>。请退出后用受邀邮箱登录。
        </p>
      );
  } else if (p && p.accountExists) {
    body = (
      <Button asChild>
        <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>登录后加入</Link>
      </Button>
    );
  } else if (p) {
    body = (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate({ name, password });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label>邮箱</Label>
          <Input value={p.email} readOnly className="font-mono" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="i-name">你的姓名</Label>
          <Input id="i-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="i-pw">设置密码</Label>
          <Input id="i-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button type="submit" disabled={accept.isPending}>
          接受邀请
        </Button>
      </form>
    );
  }
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="flex items-center gap-2 text-lg font-bold">
        <Logo size={26} />
        Flower
      </div>
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-lg border bg-card p-6 shadow-sm">
        {p && <h1 className="text-xl font-semibold">{p.orgName} 邀请你加入</h1>}
        {body}
        <FormError error={accept.error} />
      </div>
    </div>
  );
}
