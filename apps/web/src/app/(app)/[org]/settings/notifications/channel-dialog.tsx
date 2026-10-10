'use client';

import { CHANNEL_KIND_LABELS, CHANNEL_KINDS, type ChannelKind } from '@flower/core/notifications';
import { type ReactNode, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { type ChannelForm, channelFormBody, channelToForm, emptyChannelForm, toggle } from '@/features/notifications/model';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useProducts } from '@/lib/queries';
import type { NotificationChannel } from '@/lib/types';

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** 登记或修改通道。初值只在挂载时读取：父组件用 key 让每次打开重新挂载。敏感字段修改时留空表示不变。 */
export function ChannelDialog({ org, channel, open, onOpenChange }: { org: string; channel: NotificationChannel | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const products = useProducts(org);
  const [form, setForm] = useState<ChannelForm>(() => (channel ? channelToForm(channel) : emptyChannelForm()));
  const set = (patch: Partial<ChannelForm>) => setForm((f) => ({ ...f, ...patch }));
  const save = useApiMutation(
    () =>
      channel
        ? api(`/orgs/${org}/notification-channels/${channel.id}`, { method: 'PATCH', body: channelFormBody(form, true) })
        : api(`/orgs/${org}/notification-channels`, { method: 'POST', body: channelFormBody(form, false) }),
    { invalidate: [notifyKeys(org)], success: channel ? '已保存' : '通道已登记', silentError: true, onSuccess: () => onOpenChange(false) },
  );
  const keep = channel ? '留空表示不变' : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{channel ? `修改通道「${channel.name}」` : '登记通道'}</DialogTitle>
            <DialogDescription>网址、签名密钥与密码加密保存，保存后只显示脱敏提示。</DialogDescription>
          </DialogHeader>
          {!channel && (
            <Field id="ch-kind" label="通道类型">
              <Select value={form.kind} onValueChange={(v) => setForm({ ...emptyChannelForm(v as ChannelKind), name: form.name, groupLabel: form.groupLabel })}>
                <SelectTrigger id="ch-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {CHANNEL_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ch-name" label="名称">
              <Input id="ch-name" required value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field id="ch-group" label="所属群" hint="仅用于展示与归组">
              <Input id="ch-group" value={form.groupLabel} onChange={(e) => set({ groupLabel: e.target.value })} />
            </Field>
          </div>
          {form.kind !== 'email' && (
            <Field id="ch-url" label={form.kind === 'wecom_robot' ? '机器人地址' : 'Webhook 地址'} hint={channel ? `当前：${channel.configHint}，留空表示不变` : undefined}>
              <Input id="ch-url" required={!channel} autoComplete="off" className="font-mono" placeholder="https://" value={form.url} onChange={(e) => set({ url: e.target.value })} />
            </Field>
          )}
          {form.kind === 'webhook' && (
            <>
              <Field id="ch-secret" label="签名密钥" hint={keep ?? '可选；填写后请求带 HMAC-SHA256 签名头'}>
                <Input id="ch-secret" type="password" autoComplete="new-password" value={form.secret} onChange={(e) => set({ secret: e.target.value })} />
              </Field>
              {channel?.configHint.includes('已设置签名密钥') && (
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox aria-label="清除签名密钥" checked={form.clearSecret} onCheckedChange={(v) => set({ clearSecret: v === true })} />
                  清除签名密钥
                </label>
              )}
            </>
          )}
          {form.kind === 'email' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ch-host" label="SMTP 服务器">
                <Input id="ch-host" required value={form.host} onChange={(e) => set({ host: e.target.value })} />
              </Field>
              <Field id="ch-port" label="端口">
                <Input id="ch-port" type="number" required min={1} max={65535} value={form.port} onChange={(e) => set({ port: e.target.value })} />
              </Field>
              <Field id="ch-user" label="用户名">
                <Input id="ch-user" required autoComplete="off" value={form.user} onChange={(e) => set({ user: e.target.value })} />
              </Field>
              <Field id="ch-pass" label="密码" hint={keep}>
                <Input id="ch-pass" type="password" required={!channel} autoComplete="new-password" value={form.pass} onChange={(e) => set({ pass: e.target.value })} />
              </Field>
              <Field id="ch-from" label="发件人">
                <Input id="ch-from" type="email" required value={form.from} onChange={(e) => set({ from: e.target.value })} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
                <Checkbox aria-label="使用 SSL" checked={form.secure} onCheckedChange={(v) => set({ secure: v === true })} />
                使用 SSL（端口 465）
              </label>
              <div className="sm:col-span-2">
                <Field id="ch-to" label="收件人" hint="多个地址用逗号、分号或换行分隔">
                  <Textarea id="ch-to" rows={2} required value={form.to} onChange={(e) => set({ to: e.target.value })} />
                </Field>
              </div>
            </div>
          )}
          <Field id="ch-rate" label="每分钟上限" hint="企业微信机器人每分钟最多 20 条">
            <Input id="ch-rate" type="number" required min={1} max={600} className="w-32" value={form.rateLimitPerMin} onChange={(e) => set({ rateLimitPerMin: e.target.value })} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">可用产品</legend>
            <p className="text-xs text-muted-foreground">都不勾选表示全部产品可用。</p>
            <div className="flex flex-wrap gap-3">
              {(products.data ?? []).map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 text-[13px]">
                  <Checkbox aria-label={p.name} checked={form.allowedProductIds.includes(p.id)} onCheckedChange={() => set({ allowedProductIds: toggle(form.allowedProductIds, p.id) })} />
                  {p.name}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox aria-label="启用" checked={form.enabled} onCheckedChange={(v) => set({ enabled: v === true })} />
            启用
          </label>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
