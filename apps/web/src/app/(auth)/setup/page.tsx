'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { suggestSlug } from '@/features/orgs/slug';
import { ApiError, api } from '@/lib/api';
import { qk, useApiMutation, useSetupStatus } from '@/lib/queries';

export default function SetupPage() {
  const qc = useQueryClient();
  const status = useSetupStatus();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [admin, setAdmin] = useState({ name: '', email: '', password: '', confirm: '' });
  const [org, setOrg] = useState({ name: '', slug: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const m = useApiMutation(
    () => api<{ org: { slug: string } }>('/setup', { method: 'POST', body: { admin: { name: admin.name, email: admin.email, password: admin.password }, org } }),
    {
      silentError: true,
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: qk.setup });
        qc.invalidateQueries({ queryKey: qk.me });
        setStep(3);
      },
    },
  );

  if (!status.data && !status.isError) return null;

  if (status.data?.initialized && step !== 3) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">已经初始化</h1>
        <p className="text-muted-foreground">这个实例已经完成初始化，不能再次创建管理员。请使用已有账号登录。</p>
        <Button asChild className="self-start">
          <Link href="/login">去登录</Link>
        </Button>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">初始化完成</h1>
        <p className="text-muted-foreground">
          你已成为实例管理员，组织「{org.name}」已创建。接下来可以邀请团队成员，或先去配置流程与字典。
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/${org.slug}/settings/members`}>邀请成员</Link>
          </Button>
          <Button asChild>
            <Link href={`/${org.slug}`}>进入组织</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (step === 1) {
          if (admin.password !== admin.confirm) return setLocalError('两次输入的密码不一致');
          setLocalError(null);
          return setStep(2);
        }
        m.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted-foreground">步骤 {step} / 3</span>
        <h1 className="text-xl font-semibold">{step === 1 ? '创建管理员账号' : '创建第一个组织'}</h1>
        <p className="text-[13px] text-muted-foreground">
          {step === 1 ? '这个账号将成为实例管理员，负责实例设置和第一个组织。' : '组织标识会出现在网址中，创建后不能修改。'}
        </p>
      </div>
      {step === 1 ? (
        <>
          <Field id="s-name" label="你的姓名" value={admin.name} onChange={(v) => setAdmin({ ...admin, name: v })} />
          <Field id="s-email" label="邮箱" type="email" value={admin.email} onChange={(v) => setAdmin({ ...admin, email: v })} />
          <Field id="s-pw" label="密码" type="password" value={admin.password} onChange={(v) => setAdmin({ ...admin, password: v })} hint="至少 8 位" />
          <Field id="s-pw2" label="确认密码" type="password" value={admin.confirm} onChange={(v) => setAdmin({ ...admin, confirm: v })} />
        </>
      ) : (
        <>
          <Field
            id="s-org"
            label="组织名称"
            value={org.name}
            onChange={(v) => setOrg({ name: v, slug: slugTouched ? org.slug : suggestSlug(v) })}
          />
          <Field
            id="s-slug"
            label="组织标识"
            mono
            value={org.slug}
            onChange={(v) => {
              setSlugTouched(true);
              setOrg({ ...org, slug: v });
            }}
            hint="小写字母、数字和连字符"
          />
        </>
      )}
      {localError && (
        <p role="alert" className="text-sm text-destructive">
          {localError}
        </p>
      )}
      <FormError error={m.error instanceof ApiError ? m.error : null} />
      <div className="flex justify-between">
        {step === 2 ? (
          <Button type="button" variant="ghost" onClick={() => setStep(1)}>
            上一步
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={m.isPending}>
          {step === 1 ? '下一步' : '完成初始化'}
        </Button>
      </div>
    </form>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type ?? 'text'}
        required
        className={props.mono ? 'font-mono' : undefined}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="text-xs text-muted-foreground">{props.hint}</span>}
    </div>
  );
}
