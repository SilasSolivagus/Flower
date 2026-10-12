'use client';

import { CHANGE_DOCUMENT_STATUSES, DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { EVENT_TYPE_LABELS, NOTIFIABLE_EVENT_TYPES, RULE_MODE_LABELS, RULE_MODES, type RuleMode } from '@flower/core/notifications';
import { useState } from 'react';
import { CheckGroup } from '@/components/check-group';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { nodeOptions } from '@/features/structure/model';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useFields, useMessageTemplates, useNodes, useNotificationSchedules, useProductChannels, useProductWorkflow } from '@/lib/queries';
import type { NotificationRule } from '@/lib/types';

const DEFAULT_TEMPLATE = 'default';
const NONE = 'none';

/** 新建或修改事件规则。初值只在挂载时读取。 */
export function RuleDialog({ org, productId, rule, onClose }: { org: string; productId: string; rule: NotificationRule | null; onClose: () => void }) {
  const channels = useProductChannels(org, productId);
  const schedules = useNotificationSchedules(org, productId);
  const templates = useMessageTemplates(org);
  const workflow = useProductWorkflow(org, productId);
  const fields = useFields(org, productId);
  const nodes = useNodes(org, productId);
  const [name, setName] = useState(rule?.name ?? '');
  const [eventTypes, setEventTypes] = useState<string[]>(rule?.eventTypes ?? []);
  const [mode, setMode] = useState<RuleMode>(rule?.mode ?? 'immediate');
  const [channelIds, setChannelIds] = useState<string[]>(rule?.channelIds ?? []);
  const [digestScheduleId, setDigestScheduleId] = useState(rule?.digestScheduleId ?? NONE);
  const [templateId, setTemplateId] = useState(rule?.templateId ?? DEFAULT_TEMPLATE);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [states, setStates] = useState<string[]>(rule?.filter.states ?? []);
  const [priorities, setPriorities] = useState<string[]>(rule?.filter.priorities ?? []);
  const [nodeIds, setNodeIds] = useState<string[]>(rule?.filter.nodeIds ?? []);
  const [documentStatuses, setDocumentStatuses] = useState<string[]>(rule?.filter.documentStatuses ?? []);
  const [fieldKeys, setFieldKeys] = useState<string[]>(rule?.filter.fields ?? []);
  const channelOptions = [...(channels.data ?? []), ...(rule?.channels ?? []).filter((c) => !(channels.data ?? []).some((x) => x.id === c.id))];
  const digests = (schedules.data ?? []).filter((s) => s.source === 'digest');
  const priorityField = fields.data?.find((f) => f.key === 'priority');
  const digestMissing = mode === 'digest' && digestScheduleId === NONE;
  // 推送方式与通道都没改时不提交通道，已停用的通道不妨碍修改其他字段
  const targetChanged = !rule || mode !== rule.mode || digestScheduleId !== (rule.digestScheduleId ?? NONE) || [...channelIds].sort().join() !== [...rule.channelIds].sort().join();
  const body = {
    name,
    eventTypes,
    filter: { states, priorities, nodeIds, documentStatuses, fields: fieldKeys },
    templateId: templateId === DEFAULT_TEMPLATE ? null : templateId,
    enabled,
    ...(targetChanged ? { mode, channelIds: mode === 'immediate' ? channelIds : [], digestScheduleId: mode === 'digest' && digestScheduleId !== NONE ? digestScheduleId : null } : {}),
  };
  const save = useApiMutation(
    () =>
      rule
        ? api(`/orgs/${org}/notification-rules/${rule.id}`, { method: 'PATCH', body })
        : api(`/orgs/${org}/products/${productId}/notification-rules`, { method: 'POST', body }),
    { invalidate: [notifyKeys(org)], success: '规则已保存', silentError: true, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{rule ? `修改规则「${rule.name}」` : '新建规则'}</DialogTitle>
            <DialogDescription>本产品发生所选事件且满足条件时推送：即时推送到通道，或合并进变更摘要定时发送。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-name">规则名称</Label>
            <Input id="rule-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <CheckGroup legend="事件" options={NOTIFIABLE_EVENT_TYPES.map((t) => ({ value: t, label: EVENT_TYPE_LABELS[t] }))} value={eventTypes} onChange={setEventTypes} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-mode">推送方式</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as RuleMode)}>
                <SelectTrigger id="rule-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {RULE_MODE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-template">模板</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="rule-template">
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
          </div>
          {mode === 'immediate' ? (
            <CheckGroup
              legend="通道"
              hint="只列出本产品可用、且已启用的通道"
              options={channelOptions.map((c) => ({ value: c.id, label: c.enabled ? c.name : `${c.name}（已停用）` }))}
              value={channelIds}
              onChange={setChannelIds}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-digest">摘要定时推送</Label>
              <Select value={digestScheduleId} onValueChange={setDigestScheduleId}>
                <SelectTrigger id="rule-digest">
                  <SelectValue placeholder="选择内容来源为「变更摘要」的定时推送" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>未选择</SelectItem>
                  {digests.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {digestMissing && <p className="text-xs text-muted-foreground">选择摘要定时推送后才能保存</p>}
            </div>
          )}
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <p className="text-sm font-medium">过滤条件（可选）</p>
            <p className="text-xs text-muted-foreground">条件之间为「且」，同一条件内多选为「或」；不适用于所选事件的条件不生效。</p>
            <CheckGroup legend="需求状态" options={(workflow.data?.version.body.states ?? []).map((s) => ({ value: s.key, label: s.label }))} value={states} onChange={setStates} />
            <CheckGroup legend="优先级" options={(priorityField?.options ?? []).map((o) => ({ value: o.key, label: o.label }))} value={priorities} onChange={setPriorities} />
            <CheckGroup
              legend="结构树节点"
              hint="含下级节点"
              options={nodeOptions(nodes.data ?? [], null).map((n) => ({ value: n.id, label: n.name, indent: n.depth - 1 }))}
              value={nodeIds}
              onChange={setNodeIds}
            />
            <CheckGroup legend="PRD 状态" options={CHANGE_DOCUMENT_STATUSES.map((s) => ({ value: s, label: DOCUMENT_STATUS_LABELS[s] }))} value={documentStatuses} onChange={setDocumentStatuses} />
            <CheckGroup legend="变化的字段" options={(fields.data ?? []).map((f) => ({ value: f.key, label: f.label }))} value={fieldKeys} onChange={setFieldKeys} />
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
            <Button type="submit" disabled={save.isPending || digestMissing}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
