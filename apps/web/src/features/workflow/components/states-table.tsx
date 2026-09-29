'use client';

import { Trash2 } from 'lucide-react';
import { ConfirmAction } from '@/components/confirm-action';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CATEGORY_COLOR, CATEGORY_LABEL } from '@/lib/labels';
import type { WorkflowBody } from '@/lib/types';
import { addState, removeState, reorderStates, setInitial, type State, updateState } from '../model';

const CATS = Object.keys(CATEGORY_LABEL) as State['category'][];

export function StatesTable({ body, onChange }: { body: WorkflowBody; onChange: (b: WorkflowBody) => void }) {
  const states = [...body.states].sort((a, b) => a.order - b.order);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[24px_minmax(0,1fr)_140px_140px_90px_72px_40px] gap-2 px-1 text-xs text-muted-foreground">
        <span />
        <span>名称</span>
        <span>类别</span>
        <span>分组</span>
        <span>key</span>
        <span>初始</span>
        <span />
      </div>
      <SortableList
        items={states}
        getId={(s) => s.key}
        onReorder={(next) => onChange(reorderStates(body, next.map((s) => s.key)))}
        renderItem={(s) => (
          <div className="grid grid-cols-[minmax(0,1fr)_140px_140px_90px_72px_40px] items-center gap-2 border-b py-1.5">
            <div className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CATEGORY_COLOR[s.category] }} />
              <Input aria-label="状态名称" className="h-8" value={s.label} onChange={(e) => onChange(updateState(body, s.key, { label: e.target.value }))} />
            </div>
            <Select value={s.category} onValueChange={(v) => onChange(updateState(body, s.key, { category: v as State['category'], color: CATEGORY_COLOR[v as State['category']] }))}>
              <SelectTrigger className="h-8" aria-label={`${s.label} 的类别`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input aria-label={`${s.label} 的分组`} className="h-8" value={s.group} onChange={(e) => onChange(updateState(body, s.key, { group: e.target.value }))} />
            <span className="font-mono text-xs text-muted-foreground">{s.key}</span>
            <input
              type="radio"
              name="initial-state"
              aria-label={`以 ${s.label} 为初始状态`}
              checked={body.initial === s.key}
              onChange={() => onChange(setInitial(body, s.key))}
              className="size-4 accent-[var(--primary)]"
            />
            <ConfirmAction
              trigger={
                <Button variant="ghost" size="icon" aria-label={`删除 ${s.label}`} disabled={body.states.length <= 1}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              }
              title={`删除状态「${s.label}」？`}
              description="与它相关的流转会一并删除。已发布的版本不受影响。"
              confirmLabel="确认删除"
              destructive
              onConfirm={() => onChange(removeState(body, s.key))}
            />
          </div>
        )}
      />
      <Button variant="outline" size="sm" className="self-start" onClick={() => onChange(addState(body, { label: '新状态', category: 'started', group: states.at(-1)?.group ?? '' }))}>
        新增状态
      </Button>
      <p className="text-xs text-muted-foreground">类别是固定的五种，用于跨产品统计；分组用于看板分泳道。</p>
    </div>
  );
}
