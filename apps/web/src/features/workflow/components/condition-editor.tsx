'use client';

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CHECK_STATE_LABEL } from '@/lib/labels';
import type { Field, WorkflowBody } from '@/lib/types';
import type { Condition } from '../model';

const STATES = Object.keys(CHECK_STATE_LABEL) as Array<keyof typeof CHECK_STATE_LABEL>;

export function ConditionEditor({
  body,
  fields,
  value,
  onChange,
  portalContainer,
}: {
  body: WorkflowBody;
  fields: Field[];
  value: Condition[];
  onChange: (next: Condition[]) => void;
  /** “添加条件”菜单的门户挂载点。在 Sheet/Dialog 内使用时需传入该容器内的节点，否则菜单不是对话框的 DOM 子孙，测试和读屏器都定位不到。 */
  portalContainer?: HTMLElement | null;
}) {
  const set = (i: number, c: Condition) => onChange(value.map((x, j) => (j === i ? c : x)));
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && <p className="text-[13px] text-muted-foreground">没有条件，随时可以流转。</p>}
      {value.map((c, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[13px] font-medium">
              {c.type === 'check_item' && '检查项处于指定状态'}
              {c.type === 'field_set' && '字段已填写'}
              {c.type === 'has_iteration' && '已加入迭代'}
              {c.type === 'has_change_document' && '已关联 PRD'}
            </span>
            <Button variant="ghost" size="icon" aria-label="删除条件" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {c.type === 'check_item' && (
            <>
              <Select value={c.item} onValueChange={(item) => set(i, { ...c, item })}>
                <SelectTrigger aria-label="检查项">
                  <SelectValue placeholder="选择检查项" />
                </SelectTrigger>
                <SelectContent>
                  {body.checkItems.map((ci) => (
                    <SelectItem key={ci.key} value={ci.key}>
                      {ci.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-3">
                {STATES.map((s) => (
                  <label key={s} className="flex items-center gap-1.5 text-[13px]">
                    <Checkbox
                      aria-label={CHECK_STATE_LABEL[s]}
                      checked={c.in.includes(s)}
                      onCheckedChange={(v) => set(i, { ...c, in: v ? [...c.in, s] : c.in.filter((x) => x !== s) })}
                    />
                    {CHECK_STATE_LABEL[s]}
                  </label>
                ))}
              </div>
            </>
          )}
          {c.type === 'field_set' && (
            <Select value={c.field} onValueChange={(field) => set(i, { ...c, field })}>
              <SelectTrigger aria-label="字段">
                <SelectValue placeholder="选择字段" />
              </SelectTrigger>
              <SelectContent>
                {fields.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ))}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="self-start">
            <Plus className="size-4" aria-hidden="true" />
            添加条件
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" container={portalContainer}>
          <DropdownMenuItem
            disabled={body.checkItems.length === 0}
            onSelect={() => onChange([...value, { type: 'check_item', item: body.checkItems[0]?.key ?? '', in: [] }])}
          >
            检查项处于指定状态
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange([...value, { type: 'field_set', field: fields[0]?.key ?? '' }])}>字段已填写</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange([...value, { type: 'has_iteration' }])}>已加入迭代</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange([...value, { type: 'has_change_document' }])}>已关联 PRD</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
