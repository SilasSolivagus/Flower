'use client';

import { useState } from 'react';
import { ColorSwatches } from '@/components/color-swatches';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Field } from '@/lib/types';

export function FieldCard({ org, field, editable, productId }: { org: string; field: Field; editable: boolean; productId?: string }) {
  const [label, setLabel] = useState('');
  const inv = { invalidate: [qk.fields(org, productId), qk.fields(org)] };
  const add = useApiMutation((v: string) => api(`/orgs/${org}/fields/${field.id}/options`, { method: 'POST', body: { label: v } }), inv);
  const update = useApiMutation(
    (v: { id: string; label?: string; color?: string | null; active?: boolean }) =>
      api(`/orgs/${org}/field-options/${v.id}`, { method: 'PATCH', body: { label: v.label, color: v.color, active: v.active } }),
    inv,
  );
  const reorder = useApiMutation((ids: string[]) => api(`/orgs/${org}/fields/${field.id}/options/order`, { method: 'PUT', body: { optionIds: ids } }), inv);
  return (
    <section aria-label={field.label} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{field.label}</h2>
        <span className="font-mono text-xs text-muted-foreground">{field.key}</span>
        <span className="text-xs text-muted-foreground">{field.cardinality === 'multi' ? '多选' : '单选'}</span>
        {field.productId && <span className="text-xs text-primary">产品覆盖</span>}
        {field.appliesTo === 'work_item' && <span className="text-xs text-muted-foreground">作用于工作项</span>}
      </div>
      {!editable ? (
        <p className="text-[13px] text-muted-foreground">
          {field.options.map((o) => o.label).join('、') || '暂无选项'}（在产品详情中覆盖后可单独编辑）
        </p>
      ) : (
        <>
          <SortableList
            items={field.options}
            getId={(o) => o.id}
            onReorder={(next) => reorder.mutate(next.map((o) => o.id))}
            renderItem={(o) => (
              <div className="flex h-9 items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" aria-label={`修改${o.label}的颜色`} className="size-4 rounded-sm border" style={{ background: o.color ?? 'transparent' }} />
                  </PopoverTrigger>
                  <PopoverContent className="w-auto">
                    <ColorSwatches label={`${o.label}的颜色`} value={o.color ?? ''} onChange={(color) => update.mutate({ id: o.id, color })} />
                  </PopoverContent>
                </Popover>
                <Input
                  aria-label="选项名称"
                  defaultValue={o.label}
                  className="h-8 w-56"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== o.label) update.mutate({ id: o.id, label: v });
                  }}
                />
                <span className="font-mono text-xs text-muted-foreground">{o.key}</span>
                <span className="flex-1" />
                <Switch aria-label={`${o.label} 启用`} checked={o.active} onCheckedChange={(active) => update.mutate({ id: o.id, active })} />
              </div>
            )}
          />
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = label.trim();
              if (!v) return;
              setLabel('');
              add.mutate(v, { onError: () => setLabel(v) });
            }}
          >
            <Input
              aria-label="新选项"
              placeholder="新选项名称"
              className="h-8 w-56"
              maxLength={20}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={add.isPending}>
              添加
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">选项只能停用，不能删除，已使用的历史数据仍能正常显示。</p>
        </>
      )}
    </section>
  );
}
