'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WORK_ITEM_STATUS_LABELS } from '@/features/tracking/model';
import { api } from '@/lib/api';
import { trackingKeys, useApiMutation, workItemListKeys } from '@/lib/queries';
import type { TrackingItem } from '@/lib/types';

type Status = keyof typeof WORK_ITEM_STATUS_LABELS;
type Failure = { id: string; reason: string };

/** 跟进「全部」表里只改工作项状态。需求行不进这批。 */
export function BatchStatusBar({ org, items, selected, onClear }: { org: string; items: TrackingItem[]; selected: string[]; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('done');
  const [failures, setFailures] = useState<Failure[]>([]);
  const labels = new Map(items.map((i) => [i.id, i.displayKey]));
  const batch = useApiMutation(
    (next: Status) =>
      api<{ updated: number; failed: Failure[] }>(`/orgs/${org}/work-items/batch-status`, { method: 'POST', body: { ids: selected, status: next } }),
    {
      invalidate: [trackingKeys(org), workItemListKeys(org)],
      onSuccess: (data) => {
        setOpen(false);
        onClear();
        if (data.failed.length === 0) {
          setFailures([]);
          toast.success(`已更新 ${data.updated} 条`);
          return;
        }
        setFailures(data.failed);
        toast.error(`成功 ${data.updated} 条 / 失败 ${data.failed.length} 条`);
      },
    },
  );
  if (selected.length === 0 && failures.length === 0) return null;
  return (
    <>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2 text-[13px]" role="region" aria-label="批量操作">
          <span>已选 {selected.length}</span>
          <Button size="sm" onClick={() => setOpen(true)}>
            改状态
          </Button>
          <Button size="sm" variant="outline" onClick={onClear}>
            取消选择
          </Button>
        </div>
      )}
      {failures.length > 0 && (
        <div role="status" className="rounded-md border border-destructive/40 bg-card px-3 py-2 text-[13px]">
          <p>
            成功 {batch.data?.updated ?? 0} 条 / 失败 {failures.length} 条
          </p>
          <ul className="mt-1 list-disc pl-5">
            {failures.map((f) => (
              <li key={f.id}>
                {labels.get(f.id) ?? f.id}：{f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>改状态</DialogTitle>
            <DialogDescription>把选中的 {selected.length} 条工作项改成同一状态。需求不在这批里。</DialogDescription>
          </DialogHeader>
          <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
            <SelectTrigger aria-label="目标状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(WORK_ITEM_STATUS_LABELS) as Status[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {WORK_ITEM_STATUS_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={batch.isPending} onClick={() => batch.mutate(status)}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
