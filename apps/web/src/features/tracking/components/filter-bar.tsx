'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DEFAULT_FILTER, hasFilter, type TrackingFilter } from '@/features/tracking/model';
import type { TrackingList } from '@/lib/types';

const ALL = '__all';

/**
 * 跟进页的筛选：产品、负责人、类型、只看暂停、只看有阻塞、含最近 30 天完成。
 * 地址栏里的值不在候选里（产品看不到或已删除、负责人已不在列表、类型选项不存在）时，仍显示为一项占位，方便看清并清除。
 */
export function TrackingFilterBar({ list, filter, onChange }: { list: TrackingList; filter: TrackingFilter; onChange: (f: TrackingFilter) => void }) {
  const set = (patch: Partial<TrackingFilter>) => onChange({ ...filter, ...patch });
  const toggle = (key: 'paused' | 'blocked' | 'done', on: boolean) =>
    set(key === 'paused' ? { paused: on } : key === 'blocked' ? { blocked: on } : { done: on });
  const productMissing = !!filter.product && !list.products.some((p) => p.id === filter.product);
  const ownerMissing = !!filter.owner && !list.owners.some((o) => o.id === filter.owner);
  const typeMissing = !!filter.type && !list.typeOptions.some((o) => o.id === filter.type);
  const flags: Array<['paused' | 'blocked' | 'done', string]> = [
    ['paused', '只看暂停'],
    ['blocked', '只看有阻塞'],
    ['done', '含最近 30 天完成'],
  ];

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2 text-[13px]">
      <Select value={filter.product ?? ALL} onValueChange={(v) => set({ product: v === ALL ? null : v })}>
        <SelectTrigger className="h-8 w-40" aria-label="产品">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部产品</SelectItem>
          {list.products.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          {productMissing && <SelectItem value={filter.product!}>（看不到的产品）</SelectItem>}
        </SelectContent>
      </Select>
      <Select value={filter.owner ?? ALL} onValueChange={(v) => set({ owner: v === ALL ? null : v })}>
        <SelectTrigger className="h-8 w-36" aria-label="负责人">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部负责人</SelectItem>
          {list.owners.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.displayName}
            </SelectItem>
          ))}
          {ownerMissing && <SelectItem value={filter.owner!}>（已不在列表中的负责人）</SelectItem>}
        </SelectContent>
      </Select>
      <Select value={filter.type ?? ALL} onValueChange={(v) => set({ type: v === ALL ? null : v })}>
        <SelectTrigger className="h-8 w-36" aria-label="类型">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部类型</SelectItem>
          {list.typeOptions.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
          {typeMissing && <SelectItem value={filter.type!}>（已不存在的类型）</SelectItem>}
        </SelectContent>
      </Select>
      {flags.map(([key, label]) => (
        <label key={key} className="flex items-center gap-1.5">
          <Checkbox checked={filter[key]} onCheckedChange={(v) => toggle(key, v === true)} />
          {label}
        </label>
      ))}
      {hasFilter(filter) && (
        <Button variant="ghost" size="sm" className="h-8" onClick={() => onChange({ ...DEFAULT_FILTER, tab: filter.tab })}>
          清除筛选
        </Button>
      )}
    </div>
  );
}
