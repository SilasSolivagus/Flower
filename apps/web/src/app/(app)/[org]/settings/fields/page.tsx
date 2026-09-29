'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ColorSwatches } from '@/components/color-swatches';
import { LevelNamesEditor } from '@/components/level-names-editor';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useLevelNames, useProducts } from '@/lib/queries';
import type { Field } from '@/lib/types';

function FieldCard({ org, field, editable, productId }: { org: string; field: Field; editable: boolean; productId?: string }) {
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
              add.mutate(v);
            }}
          >
            <Input aria-label="新选项" placeholder="新选项名称" className="h-8 w-56" value={label} onChange={(e) => setLabel(e.target.value)} />
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

function FieldsPage() {
  const { org } = useParams<{ org: string }>();
  const products = useProducts(org);
  const [scope, setScope] = useState<string>('org');
  const productId = scope === 'org' ? undefined : scope;
  const fields = useFields(org, productId);
  const levels = useLevelNames(org);
  const saveLevels = useApiMutation((names: string[]) => api(`/orgs/${org}/level-names`, { method: 'PUT', body: { names } }), {
    invalidate: [qk.levels(org)],
    success: '已保存',
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '字段字典' }]}
        title="字段字典"
        description="字典实时生效。产品可以覆盖某个字段，之后独立维护自己的选项。"
        actions={
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="w-48" aria-label="查看范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="org">组织字段</SelectItem>
              {products.data?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  产品：{p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="grid grid-cols-2 gap-4">
        {fields.data?.map((f) => (
          <FieldCard key={f.id} org={org} field={f} productId={productId} editable={scope === 'org' ? f.productId === null : f.productId !== null} />
        ))}
      </div>
      {scope === 'org' && (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h2 className="font-semibold">结构树层级叫法</h2>
          {levels.data && <LevelNamesEditor value={levels.data.names} saving={saveLevels.isPending} onSave={(names) => saveLevels.mutate(names)} />}
        </section>
      )}
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <FieldsPage />
    </RequireOrgAdmin>
  );
}
