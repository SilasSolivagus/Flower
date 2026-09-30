'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { releaseKeys, requirementKeys, useApiMutation, useFields } from '@/lib/queries';
import type { IterationDetail, Product, Release } from '@/lib/types';

const NONE = '__none';
type Form = { productId: string; versionName: string; platformOptionId: string; plannedDate: string; notes: string };

export function ReleaseDialog({
  org,
  open,
  onOpenChange,
  iteration,
  release,
  products,
}: {
  org: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  iteration: IterationDetail;
  release: Release | null;
  products: Product[];
}) {
  const [form, setForm] = useState<Form>({ productId: '', versionName: '', platformOptionId: NONE, plannedDate: '', notes: '' });
  // 打开对话框（或换了要编辑的版本）时填表；在渲染期间调整，不用 effect
  const source = open ? release : undefined;
  const [synced, setSynced] = useState<Release | null | undefined>(undefined);
  if (source !== synced) {
    setSynced(source);
    if (source !== undefined) {
      setForm(
        source
          ? { productId: source.productId, versionName: source.versionName, platformOptionId: source.platform?.id ?? NONE, plannedDate: source.plannedDate ?? '', notes: source.notes ?? '' }
          : { productId: iteration.product?.id ?? products[0]?.id ?? '', versionName: '', platformOptionId: NONE, plannedDate: iteration.endDate, notes: '' },
      );
    }
  }
  // 只在对话框打开时取字段定义：组织级字段接口对访客型产品管理员会返回 403。
  const fields = useFields(org, form.productId || undefined, open);
  const platformOptions = (fields.data?.find((f) => f.key === 'platform')?.options ?? []).filter((o) => o.active || o.id === form.platformOptionId);
  const save = useApiMutation(
    () => {
      const body = {
        versionName: form.versionName,
        platformOptionId: form.platformOptionId === NONE ? null : form.platformOptionId,
        plannedDate: form.plannedDate,
        notes: form.notes.trim() || null,
      };
      if (release) return api(`/orgs/${org}/releases/${release.id}`, { method: 'PATCH', body });
      return api(`/orgs/${org}/releases`, { method: 'POST', body: { ...body, productId: form.productId, iterationId: iteration.id } });
    },
    {
      invalidate: [releaseKeys(org), requirementKeys(org)],
      silentError: true,
      success: release ? '已保存' : '已创建发布版本',
      onSuccess: () => onOpenChange(false),
    },
  );
  const close = () => {
    save.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{release ? `编辑「${release.versionName}」` : '新建发布版本'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {!release && !iteration.product && (
            <div className="flex flex-col gap-1.5">
              <Label>产品</Label>
              <Select value={form.productId} onValueChange={(v) => setForm((f) => ({ ...f, productId: v, platformOptionId: NONE }))}>
                <SelectTrigger aria-label="产品">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="rel-version">版本号</Label>
              <Input id="rel-version" className="font-mono" value={form.versionName} maxLength={50} autoFocus onChange={(e) => setForm((f) => ({ ...f, versionName: e.target.value }))} />
            </div>
            <div className="flex w-40 flex-col gap-1.5">
              <Label>平台</Label>
              <Select value={form.platformOptionId} onValueChange={(v) => setForm((f) => ({ ...f, platformOptionId: v }))}>
                <SelectTrigger aria-label="平台">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不区分平台</SelectItem>
                  {platformOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rel-date">计划发布日期</Label>
            <Input id="rel-date" type="date" className="w-44 font-mono" value={form.plannedDate} onChange={(e) => setForm((f) => ({ ...f, plannedDate: e.target.value }))} />
            {release?.baselineDate && (
              <span className="text-xs text-muted-foreground">
                基线日期 <span className="font-mono">{release.baselineDate}</span>，修改计划日期不会改变基线。
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rel-notes">说明</Label>
            <Textarea id="rel-notes" value={form.notes} maxLength={2000} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              取消
            </Button>
            <Button type="submit" disabled={!form.versionName.trim() || !form.plannedDate || !form.productId || save.isPending}>
              {release ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
