'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ApiError } from '@/lib/api';

export function PublishDialog({
  nextVersion,
  disabled,
  pending,
  error,
  onPublish,
}: {
  nextVersion: number;
  disabled: boolean;
  pending: boolean;
  error: ApiError | null;
  onPublish: (note: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>发布为 v{nextVersion}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>发布 v{nextVersion}</DialogTitle>
          <DialogDescription>发布后版本不可修改。已在用旧版本的产品不受影响。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pub-note">版本说明</Label>
          <Textarea id="pub-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：增加可行性评估检查项" />
        </div>
        <FormError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            disabled={pending}
            onClick={async () => {
              try {
                await onPublish(note);
              } catch {
                // 失败原因由上面的 FormError（error 属性）显示，对话框保持打开
                return;
              }
              setOpen(false);
              setNote('');
            }}
          >
            确认发布
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
