'use client';

import { Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableCell, TableRow } from '@/components/ui/table';
import { type ParsedNumber, parseHalfDays, parseProgress } from '@/features/gantt/model';
import { pickerOptions } from '@/features/members/model';
import { ApiError, api } from '@/lib/api';
import { TASK_FLAG_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import { taskMutationKeys, useApiMutation } from '@/lib/queries';
import type { Member, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

type Patch = {
  alias?: string | null;
  assigneeMemberId?: string | null;
  status?: Task['status'];
  planStart?: string | null;
  planDays?: number | null;
  delayDays?: number | null;
  flag?: Task['flag'];
  starred?: boolean;
  note?: string | null;
  progress?: number | null;
};
const NONE = 'none';
const COLUMN_COUNT = 9;
/** 用非受控输入框（defaultValue + key）的字段：key 只随该字段自己的服务端值和自己的拒绝次数变化，
 * 这样保存或拒绝一个字段不会牵连同一行里正在编辑的其他字段。 */
type FieldKey = 'alias' | 'planStart' | 'planDays' | 'progressOverride' | 'delayDays' | 'note';

/** 甘特表的一行：文本和数字输入失焦时保存（与 push 一致），下拉框选中后立即保存。 */
export function TaskRow({ org, task: t, people }: { org: string; task: Task; people: Member[] | null }) {
  // 每个非受控输入框各自的拒绝计数：保存失败或输入不合法时该字段加一，恢复服务端的值；不影响同一行的其他字段
  const [rejects, setRejects] = useState<Partial<Record<FieldKey, number>>>({});
  const rejectField = (field: FieldKey) => setRejects((r) => ({ ...r, [field]: (r[field] ?? 0) + 1 }));
  const fieldKey = (field: FieldKey, value: string | number | null) => `${field}:${value ?? ''}:${rejects[field] ?? 0}`;
  // 输入不合法时（不经过 mutation）单独保存的错误；下一次保存会清空
  const [localError, setLocalError] = useState<ApiError | null>(null);
  const invalidate = taskMutationKeys(org);
  const patch = useApiMutation((body: Patch) => api(`/orgs/${org}/tasks/${t.id}`, { method: 'PATCH', body }), { invalidate, silentError: true });
  const remove = useApiMutation(() => api(`/orgs/${org}/tasks/${t.id}`, { method: 'DELETE' }), { invalidate, success: '已删除任务' });
  const save = (body: Patch, field?: FieldKey) => {
    setLocalError(null);
    patch.mutate(body, { onError: field ? () => rejectField(field) : undefined });
  };
  const saveNumber = (parsed: ParsedNumber, current: number | null, field: FieldKey, toPatch: (v: number | null) => Patch) => {
    if (!parsed.ok) {
      setLocalError(new ApiError(0, 'invalid', parsed.message, null));
      rejectField(field);
      return;
    }
    if (parsed.value !== current) save(toPatch(parsed.value), field);
  };
  const error = localError ?? patch.error;
  const label = t.title;
  const disabled = !t.canEdit;

  return (
    <>
      <TableRow className="h-10 even:bg-zebra">
        <TableCell>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.starred ? `取消重点 ${label}` : `标为重点 ${label}`}
            aria-pressed={t.starred}
            disabled={disabled || patch.isPending}
            onClick={() => save({ starred: !t.starred })}
          >
            <Star className={cn('size-4', t.starred ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground')} aria-hidden="true" />
          </Button>
        </TableCell>
        <TableCell className="overflow-hidden">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={`/${org}/tasks/${t.displayKey}`} className="shrink-0 font-mono text-[12px] text-muted-foreground hover:underline">
              {t.displayKey}
            </Link>
            <Input
              key={fieldKey('alias', t.alias)}
              aria-label={`别名 ${label}`}
              defaultValue={t.alias ?? ''}
              placeholder={t.title}
              maxLength={50}
              disabled={disabled}
              className="h-8 w-32 shrink-0 font-medium"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (t.alias ?? '')) save({ alias: v || null }, 'alias');
              }}
            />
            <div className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-muted-foreground">
              {t.requirement ? (
                <Link href={`/${org}/requirements/${t.requirement.displayKey}`} className="flex min-w-0 shrink-0 gap-1.5 hover:underline">
                  <span className="font-mono">{t.requirement.displayKey}</span>
                </Link>
              ) : (
                <span className="shrink-0">未挂需求</span>
              )}
              <span className="truncate">· {t.title}</span>
            </div>
          </div>
        </TableCell>
        <TableCell>
          {people ? (
            <MemberPicker
              label={`负责人 ${label}`}
              className="h-8 w-full"
              noneLabel="未指派"
              options={pickerOptions(people, t.assignee)}
              value={t.assignee?.id ?? null}
              disabled={disabled}
              onChange={(id) => save({ assigneeMemberId: id })}
            />
          ) : (
            <span className="text-[13px]">{t.assignee?.displayName ?? '未指派'}</span>
          )}
        </TableCell>
        <TableCell>
          <Select value={t.status} disabled={disabled} onValueChange={(v) => save({ status: v as Task['status'] })}>
            <SelectTrigger className="h-8 w-full" aria-label={`状态 ${label}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TASK_STATUS_LABEL) as Array<Task['status']>).map((s) => (
                <SelectItem key={s} value={s}>
                  {TASK_STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
        <TableCell>
          <div className="flex gap-1.5">
            <Input
              key={fieldKey('planStart', t.planStart)}
              type="date"
              aria-label={`开始日期 ${label}`}
              defaultValue={t.planStart ?? ''}
              disabled={disabled}
              className="h-8 w-36 font-mono text-[12px]"
              onBlur={(e) => {
                const v = e.target.value || null;
                if (v !== t.planStart) save({ planStart: v }, 'planStart');
              }}
            />
            <Input
              key={fieldKey('planDays', t.planDays)}
              type="number"
              min={0.5}
              step={0.5}
              aria-label={`工期 ${label}`}
              defaultValue={t.planDays ?? ''}
              disabled={disabled}
              className="h-8 w-20"
              onBlur={(e) => saveNumber(parseHalfDays(e.target.value, 0.5, '工期'), t.planDays, 'planDays', (v) => ({ planDays: v }))}
            />
          </div>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <Input
              key={fieldKey('progressOverride', t.progressOverride)}
              type="number"
              min={0}
              max={100}
              step={1}
              aria-label={`进度 ${label}`}
              defaultValue={t.progressOverride ?? ''}
              placeholder="自动"
              disabled={disabled}
              className="h-8 w-20"
              onBlur={(e) => saveNumber(parseProgress(e.target.value), t.progressOverride, 'progressOverride', (v) => ({ progress: v }))}
            />
            <div
              role="progressbar"
              aria-label={`${label} 进度`}
              aria-valuenow={t.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 flex-1 rounded-full bg-muted"
            >
              <div className={cn('h-full rounded-full', t.progress >= 100 ? 'bg-emerald-600' : 'bg-primary')} style={{ width: `${t.progress}%` }} />
            </div>
            <span className="w-9 text-right font-mono text-[12px]">{t.progress}%</span>
          </div>
        </TableCell>
        <TableCell>
          <div className="flex gap-1.5">
            <Select value={t.flag ?? NONE} disabled={disabled} onValueChange={(v) => save({ flag: v === NONE ? null : 'attention' })}>
              <SelectTrigger className="h-8 w-20" aria-label={`标记 ${label}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>正常</SelectItem>
                <SelectItem value="attention">{TASK_FLAG_LABEL.attention}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              key={fieldKey('delayDays', t.delayDays)}
              type="number"
              min={0}
              step={0.5}
              aria-label={`延期 ${label}`}
              defaultValue={t.delayDays ?? ''}
              placeholder="0"
              disabled={disabled}
              className="h-8 w-20"
              onBlur={(e) => saveNumber(parseHalfDays(e.target.value, 0, '延期'), t.delayDays, 'delayDays', (v) => ({ delayDays: v }))}
            />
          </div>
        </TableCell>
        <TableCell>
          <Input
            key={fieldKey('note', t.note)}
            aria-label={`说明 ${label}`}
            defaultValue={t.note ?? ''}
            placeholder="卡点、周知事项"
            maxLength={200}
            disabled={disabled}
            className="h-8"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (t.note ?? '')) save({ note: v || null }, 'note');
            }}
          />
        </TableCell>
        <TableCell>
          {t.canEdit && (
            <ConfirmAction
              trigger={
                <Button variant="ghost" size="icon-sm" aria-label={`删除 ${label}`}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              }
              title={`删除「${label}」？`}
              description="删除后不能恢复。"
              confirmLabel="删除"
              destructive
              onConfirm={() => remove.mutate(undefined)}
            />
          )}
        </TableCell>
      </TableRow>
      {error && (
        <TableRow className="even:bg-zebra">
          <TableCell colSpan={COLUMN_COUNT} className="py-1.5">
            <FormError error={error} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
