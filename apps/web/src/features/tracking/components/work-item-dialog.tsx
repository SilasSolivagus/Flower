'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { api } from '@/lib/api';
import { qk, trackingKeys, useApiMutation, useFields, useMembers, useOrg } from '@/lib/queries';
import type { WorkItemDetail } from '@/lib/types';

const NONE = '__none';

function WorkItemForm({ org, products, onDone }: { org: string; products: Array<{ id: string; name: string }>; onDone: () => void }) {
  const orgQ = useOrg(org);
  const canList = canListMembers(orgQ.data?.me);
  const members = useMembers(org, canList);
  const fields = useFields(org, undefined, canList);
  const [title, setTitle] = useState('');
  const [workType, setWorkType] = useState(NONE);
  const [owner, setOwner] = useState<string | null>(orgQ.data?.me.memberId ?? null);
  const [product, setProduct] = useState(NONE);
  const [startedOn, setStartedOn] = useState('');
  const [expected, setExpected] = useState('');
  const create = useApiMutation(
    () =>
      api<{ workItem: WorkItemDetail }>(`/orgs/${org}/work-items`, {
        method: 'POST',
        body: {
          title,
          workTypeOptionId: workType === NONE ? null : workType,
          ownerMemberId: owner,
          productId: product === NONE ? null : product,
          startedOn: startedOn || null,
          expectedDate: expected || null,
        },
      }),
    {
      invalidate: [trackingKeys(org), qk.workbench],
      silentError: true,
      onSuccess: (d) => {
        toast.success(`已创建 ${d.workItem.displayKey}`);
        onDone();
      },
    },
  );
  const workTypeField = fields.data?.find((f) => f.key === 'work_type');
  const people = activePeople(members.data ?? []);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wi-title">标题</Label>
        <Input id="wi-title" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-4">
        {workTypeField && (
          <div className="flex flex-col gap-1.5">
            <Label>工作类型</Label>
            <Select value={workType} onValueChange={setWorkType}>
              <SelectTrigger className="w-36" aria-label="工作类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>不填</SelectItem>
                {workTypeField.options
                  .filter((o) => o.active)
                  .map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label>关联产品</Label>
          <Select value={product} onValueChange={setProduct}>
            <SelectTrigger className="w-40" aria-label="关联产品">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不关联产品</SelectItem>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {people.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>负责人</Label>
          <MemberPicker label="负责人" className="w-full" noneLabel="不指定" options={pickerOptions(people, null)} value={owner} onChange={setOwner} modal />
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wi-start">启动日期</Label>
          <Input id="wi-start" type="date" className="w-44" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wi-expected">预计完成日期</Label>
          <Input id="wi-expected" type="date" className="w-44" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      </div>
      <FormError error={create.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" disabled={!title.trim() || create.isPending}>
          创建
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 新建工作项：标题、工作类型、负责人（默认自己）、可选产品、启动日期、预计完成日期。 */
export function CreateWorkItemDialog({
  org,
  products,
  open,
  onOpenChange,
}: {
  org: string;
  products: Array<{ id: string; name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建工作项</DialogTitle>
        </DialogHeader>
        {open && <WorkItemForm org={org} products={products} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
