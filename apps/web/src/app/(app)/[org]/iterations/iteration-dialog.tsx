'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type IterationForm, iterationFormError } from '@/features/iterations/model';
import { api } from '@/lib/api';
import { iterationKeys, useApiMutation } from '@/lib/queries';
import type { Iteration, IterationMilestone, Product } from '@/lib/types';

const SPECIAL = '__special';
const EMPTY: IterationForm = { name: '', startDate: '', endDate: '', milestones: [] };

export function IterationDialog({
  org,
  open,
  iteration,
  products,
  allowSpecial,
  onOpenChange,
}: {
  org: string;
  open: boolean;
  iteration: Iteration | null;
  products: Product[];
  allowSpecial: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<IterationForm>(EMPTY);
  const [scope, setScope] = useState('');
  // 打开对话框（或换了要编辑的迭代）时用来源数据填表；在渲染期间调整，不用 effect
  const source = open ? iteration : undefined;
  const [synced, setSynced] = useState<Iteration | null | undefined>(undefined);
  if (source !== synced) {
    setSynced(source);
    if (source !== undefined) {
      setForm(source ? { name: source.name, startDate: source.startDate, endDate: source.endDate, milestones: source.milestones } : EMPTY);
      setScope(source ? (source.product?.id ?? SPECIAL) : (products[0]?.id ?? (allowSpecial ? SPECIAL : '')));
    }
  }
  const save = useApiMutation(
    () => {
      const body = { name: form.name, startDate: form.startDate, endDate: form.endDate, milestones: form.milestones };
      if (iteration) return api(`/orgs/${org}/iterations/${iteration.id}`, { method: 'PATCH', body });
      return api(`/orgs/${org}/iterations`, {
        method: 'POST',
        body: scope === SPECIAL ? { ...body, type: 'special' } : { ...body, type: 'regular', productId: scope },
      });
    },
    { invalidate: [iterationKeys(org)], silentError: true, success: iteration ? '已保存' : '已创建迭代', onSuccess: () => onOpenChange(false) },
  );
  const close = () => {
    save.reset();
    onOpenChange(false);
  };
  const setMilestone = (i: number, patch: Partial<IterationMilestone>) =>
    setForm((f) => ({ ...f, milestones: f.milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const localError = iterationFormError(form);
  const touched = !!(form.name || form.startDate || form.endDate);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{iteration ? `编辑「${iteration.name}」` : '新建迭代'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {!iteration && (
            <div className="flex flex-col gap-1.5">
              <Label>所属</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger aria-label="所属">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}（常规迭代）
                    </SelectItem>
                  ))}
                  {allowSpecial && <SelectItem value={SPECIAL}>专项（跨产品）</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="it-name">名称</Label>
            <Input id="it-name" value={form.name} maxLength={50} autoFocus onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="flex gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="it-start">开始日期</Label>
              <Input id="it-start" type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="it-end">结束日期</Label>
              <Input id="it-end" type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
            </div>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">里程碑</legend>
            {form.milestones.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={`里程碑 ${i + 1} 名称`} className="h-8 w-40" maxLength={20} value={m.label} onChange={(e) => setMilestone(i, { label: e.target.value })} />
                <Input aria-label={`里程碑 ${i + 1} 日期`} type="date" className="h-8 w-40" value={m.date} onChange={(e) => setMilestone(i, { date: e.target.value })} />
                <Button type="button" variant="ghost" size="sm" onClick={() => setForm((f) => ({ ...f, milestones: f.milestones.filter((_, j) => j !== i) }))}>
                  删除
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setForm((f) => ({ ...f, milestones: [...f.milestones, { label: '', date: '' }] }))}
            >
              添加里程碑
            </Button>
          </fieldset>
          {touched && localError && <p className="text-xs text-muted-foreground">{localError}</p>}
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              取消
            </Button>
            <Button type="submit" disabled={!!localError || (!iteration && !scope) || save.isPending}>
              {iteration ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
