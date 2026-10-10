'use client';

import { SCHEDULE_SOURCE_LABELS, SCHEDULE_SOURCES, type ScheduleSource } from '@flower/core/notifications';
import { useState } from 'react';
import { CheckGroup } from '@/components/check-group';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useFields, useMessageTemplates, useProductChannels, useProducts } from '@/lib/queries';
import type { NotificationSchedule } from '@/lib/types';

const DEFAULT_TEMPLATE = 'default';
type SourceConfig = { titlePrefix?: string; emptyBehavior?: 'skip' | 'notice'; onlineSourceKeys?: string[] };

/** 新建或修改定时推送。fixedProductId 给定时（产品设置页）不能选产品。初值只在挂载时读取。 */
export function ScheduleDialog({ org, productId: fixedProductId, schedule, onClose }: { org: string; productId?: string; schedule: NotificationSchedule | null; onClose: () => void }) {
  const products = useProducts(org);
  const templates = useMessageTemplates(org);
  const cfg = (schedule?.sourceConfig ?? {}) as SourceConfig;
  const [productId, setProductId] = useState(schedule?.productId ?? fixedProductId ?? '');
  const [name, setName] = useState(schedule?.name ?? '');
  const [source, setSource] = useState<ScheduleSource>(schedule?.source ?? 'overview_card');
  const [cron, setCron] = useState(schedule?.cron ?? '0 19 * * 1-5');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? 'Asia/Shanghai');
  const [channelIds, setChannelIds] = useState<string[]>(schedule?.channelIds ?? []);
  const [templateId, setTemplateId] = useState(schedule?.templateId ?? DEFAULT_TEMPLATE);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [failThreshold, setFailThreshold] = useState(String(schedule?.failThreshold ?? 1));
  const [titlePrefix, setTitlePrefix] = useState(cfg.titlePrefix ?? '');
  const [emptyBehavior, setEmptyBehavior] = useState<'skip' | 'notice'>(cfg.emptyBehavior ?? 'skip');
  const [onlineKeys, setOnlineKeys] = useState<string[]>(cfg.onlineSourceKeys ?? []);
  const channels = useProductChannels(org, productId);
  const fields = useFields(org, productId || undefined, source === 'new_requirements' && !!productId);
  const sourceOptions = fields.data?.find((f) => f.key === 'source')?.options ?? [];
  // 本产品可用的通道，加上当前已选、但已停用的通道（迁移来的定时推送）
  const options = [...(channels.data ?? []), ...(schedule?.channels ?? []).filter((c) => !(channels.data ?? []).some((x) => x.id === c.id))];
  const sourceConfig =
    source === 'overview_card' ? (titlePrefix.trim() ? { titlePrefix: titlePrefix.trim() } : {}) : source === 'new_requirements' ? { emptyBehavior, onlineSourceKeys: onlineKeys } : {};
  // 通道没有改动时不提交，已停用的通道不妨碍修改其他字段
  const channelsChanged = !schedule || [...channelIds].sort().join() !== [...schedule.channelIds].sort().join();
  const body = {
    name,
    cron,
    timezone,
    sourceConfig,
    templateId: templateId === DEFAULT_TEMPLATE ? null : templateId,
    enabled,
    failThreshold: Number(failThreshold),
    ...(channelsChanged ? { channelIds } : {}),
  };
  const save = useApiMutation(
    () =>
      schedule
        ? api(`/orgs/${org}/notification-schedules/${schedule.id}`, { method: 'PATCH', body })
        : api(`/orgs/${org}/notification-schedules`, { method: 'POST', body: { ...body, productId, source, channelIds } }),
    { invalidate: [notifyKeys(org)], success: '定时推送已保存', silentError: true, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{schedule ? `修改定时推送「${schedule.name}」` : '新建定时推送'}</DialogTitle>
            <DialogDescription>到点后按内容来源生成消息，用模板渲染后发到所选通道。</DialogDescription>
          </DialogHeader>
          {!schedule && !fixedProductId && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-product">产品</Label>
              <Select
                value={productId}
                onValueChange={(v) => {
                  setProductId(v);
                  setChannelIds([]);
                }}
              >
                <SelectTrigger id="sc-product">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {(products.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-name">名称</Label>
              <Input id="sc-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-source">内容来源</Label>
              <Select value={source} onValueChange={(v) => setSource(v as ScheduleSource)} disabled={!!schedule}>
                <SelectTrigger id="sc-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SCHEDULE_SOURCE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-cron">定时规则</Label>
              <Input id="sc-cron" required className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
              <span className="text-xs text-muted-foreground">5 段：分 时 日 月 周。0 19 * * 1-5 为工作日 19:00</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-tz">时区</Label>
              <Input id="sc-tz" required className="font-mono" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
          </div>
          {productId ? (
            <CheckGroup
              legend="通道"
              hint="只列出本产品可用、且已启用的通道"
              options={options.map((c) => ({ value: c.id, label: c.enabled ? c.name : `${c.name}（已停用）` }))}
              value={channelIds}
              onChange={setChannelIds}
            />
          ) : (
            <p className="text-[13px] text-muted-foreground">先选择产品，再选择通道。</p>
          )}
          {source === 'overview_card' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-title">卡片标题前缀</Label>
              <Input id="sc-title" placeholder="默认为「产品名 研发日报」" value={titlePrefix} onChange={(e) => setTitlePrefix(e.target.value)} />
            </div>
          )}
          {source === 'new_requirements' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sc-empty">没有新需求时</Label>
                <Select value={emptyBehavior} onValueChange={(v) => setEmptyBehavior(v as 'skip' | 'notice')}>
                  <SelectTrigger id="sc-empty">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">不发送</SelectItem>
                    <SelectItem value="notice">发送「没有新需求」</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <CheckGroup
                legend="线上转需求的来源"
                hint="「来源」字段为这些选项的需求单独列为「线上转需求」"
                options={sourceOptions.map((o) => ({ value: o.key, label: o.label }))}
                value={onlineKeys}
                onChange={setOnlineKeys}
              />
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-template">模板</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="sc-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_TEMPLATE}>默认模板</SelectItem>
                  {(templates.data ?? [])
                    .filter((t) => !t.builtin)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-threshold">连续失败几次告警</Label>
              <Input id="sc-threshold" type="number" min={1} max={10} required value={failThreshold} onChange={(e) => setFailThreshold(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox aria-label="启用" checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            启用
          </label>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
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
