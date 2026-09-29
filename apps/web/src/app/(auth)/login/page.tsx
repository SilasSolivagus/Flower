'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeNext } from '@/features/auth/next';
import { api } from '@/lib/api';
import { qk, useApiMutation, useSetupStatus } from '@/lib/queries';
import type { Account, MyOrg } from '@/lib/types';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const status = useSetupStatus();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const target = safeNext(params.get('next'));
  const m = useApiMutation(() => api('/auth/login', { method: 'POST', body: { email, password } }), {
    silentError: true,
    onSuccess: async () => {
      const me = await qc.fetchQuery({ queryKey: qk.me, queryFn: () => api<{ account: Account; orgs: MyOrg[] }>('/me') });
      // 还没有落地页（Task 7），默认跳转到跳转参数指定的地址；没有指定时进入第一个所属组织。
      router.replace(target !== '/' ? target : (me.orgs[0] ? `/${me.orgs[0].slug}` : '/'));
    },
  });

  useEffect(() => {
    if (status.data && !status.data.initialized) router.replace('/setup');
  }, [status.data, router]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate(undefined);
      }}
    >
      <h1 className="text-xl font-semibold">登录</h1>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="l-email">邮箱</Label>
        <Input id="l-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="l-pw">密码</Label>
        <Input
          id="l-pw"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <FormError error={m.error} />
      <Button type="submit" disabled={m.isPending}>
        登录
      </Button>
      {status.data?.allowSignup && (
        <p className="text-center text-[13px] text-muted-foreground">
          还没有账号？
          <Link href="/register" className="text-primary hover:underline">
            注册
          </Link>
        </p>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
