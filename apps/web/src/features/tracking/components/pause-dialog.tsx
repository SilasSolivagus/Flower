'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/queries';

type Invalidate = ReadonlyArray<readonly unknown[]>;

function PauseForm({ path, invalidate, onDone }: { path: string; invalidate: Invalidate; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const pause = useApiMutation(() => api(`${path}/pause`, { method: 'POST', body: { reason: reason.trim() } }), { invalidate, silentError: true, success: '已暂停', onSuccess: onDone });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        pause.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pause-reason">暂停原因</Label>
        <Textarea id="pause-reason" autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <FormError error={pause.error} />
      <DialogFooter>
        <Button type="submit" disabled={!reason.trim() || pause.isPending}>
          确认暂停
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 暂停：填原因后 POST `${path}/pause`。path 为需求或工作项的接口路径（如 /orgs/acme/requirements/{id}）。 */
export function PauseDialog({ open, onOpenChange, path, invalidate }: { open: boolean; onOpenChange: (open: boolean) => void; path: string; invalidate: Invalidate }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>暂停</DialogTitle>
          <DialogDescription>暂停期间不计停留天数、不标老化，状态保持不变；恢复后接着算。</DialogDescription>
        </DialogHeader>
        {open && <PauseForm path={path} invalidate={invalidate} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
