'use client';

import { useState } from 'react';
import { CopyField } from '@/components/copy-field';
import { FormError } from '@/components/form-error';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation, useWecomApp } from '@/lib/queries';
import type { WecomAppSettings } from '@/lib/types';

function WecomAppForm({ org, settings }: { org: string; settings: WecomAppSettings }) {
  const [v, setV] = useState({ corpId: settings.app?.corpId ?? '', agentId: settings.app?.agentId ?? '', secret: '', bindEnabled: settings.app?.bindEnabled ?? false });
  const save = useApiMutation(
    () =>
      api(`/orgs/${org}/wecom-app`, {
        method: 'PUT',
        body: { corpId: v.corpId, agentId: v.agentId, bindEnabled: v.bindEnabled, ...(v.secret.trim() ? { secret: v.secret.trim() } : {}) },
      }),
    { invalidate: [qk.wecomApp(org)], success: '已保存', silentError: true },
  );
  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <p className="text-[13px] text-muted-foreground">
        企业微信自建应用的网页授权，用于成员在个人设置里扫码绑定企业微信账号。应用密钥加密保存，页面上只显示末 4 位；服务端只访问 qyapi.weixin.qq.com。
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wecom-corp">企业 ID</Label>
        <Input id="wecom-corp" className="font-mono" value={v.corpId} onChange={(e) => setV({ ...v, corpId: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wecom-agent">应用 ID（AgentId）</Label>
        <Input id="wecom-agent" className="font-mono" inputMode="numeric" value={v.agentId} onChange={(e) => setV({ ...v, agentId: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wecom-secret">应用密钥</Label>
        <Input
          id="wecom-secret"
          type="password"
          autoComplete="off"
          className="font-mono"
          placeholder={settings.app ? `已设置 ${settings.app.secretHint}，留空表示不变` : '首次保存必填'}
          value={v.secret}
          onChange={(e) => setV({ ...v, secret: e.target.value })}
        />
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <Switch aria-label="允许成员扫码绑定" checked={v.bindEnabled} onCheckedChange={(b) => setV({ ...v, bindEnabled: b })} />
        允许成员扫码绑定
      </label>
      <CopyField label="回调地址" value={settings.callbackUrl} />
      <CopyField label="授权回调域（填到自建应用的网页授权设置里）" value={settings.callbackDomain} />
      <FormError error={save.error} />
      <Button type="submit" className="self-start" disabled={save.isPending}>
        保存
      </Button>
    </form>
  );
}

/** 组织设置「推送」→「企业微信应用」。保存后按更新时间重新挂载表单，密钥框回到空。 */
export function WecomAppTab({ org }: { org: string }) {
  const q = useWecomApp(org);
  if (q.isError) return <LoadError message="加载企业微信应用失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return <WecomAppForm key={q.data.app?.updatedAt ?? 'new'} org={org} settings={q.data} />;
}
