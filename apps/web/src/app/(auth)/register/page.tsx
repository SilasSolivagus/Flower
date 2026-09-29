'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation, useSetupStatus } from '@/lib/queries';

export default function RegisterPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const status = useSetupStatus();
  const [v, setV] = useState({ name: '', email: '', password: '' });
  const m = useApiMutation(() => api('/auth/register', { method: 'POST', body: v }), {
    silentError: true,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
      router.replace('/');
    },
  });
  if (status.data && !status.data.allowSignup) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">暂不开放注册</h1>
        <p className="text-muted-foreground">当前实例仅支持邀请加入。请向组织管理员索取邀请链接。</p>
        <Link href="/login" className="text-primary hover:underline">
          返回登录
        </Link>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate(undefined);
      }}
    >
      <h1 className="text-xl font-semibold">注册</h1>
      {(['name', 'email', 'password'] as const).map((k) => (
        <div key={k} className="flex flex-col gap-1.5">
          <Label htmlFor={`r-${k}`}>{{ name: '姓名', email: '邮箱', password: '密码' }[k]}</Label>
          <Input
            id={`r-${k}`}
            type={k === 'password' ? 'password' : k === 'email' ? 'email' : 'text'}
            required
            value={v[k]}
            onChange={(e) => setV({ ...v, [k]: e.target.value })}
          />
        </div>
      ))}
      <FormError error={m.error} />
      <Button type="submit" disabled={m.isPending}>
        注册
      </Button>
    </form>
  );
}
