'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';

export function PlaceholderDialog({ org, open, onOpenChange }: { org: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [v, setV] = useState({ displayName: '', department: '', email: '' });
  const m = useApiMutation(
    () =>
      api(`/orgs/${org}/members`, {
        method: 'POST',
        body: { displayName: v.displayName, ...(v.department ? { department: v.department } : {}), ...(v.email ? { email: v.email } : {}) },
      }),
    {
      invalidate: [qk.members(org)],
      success: '已登记',
      silentError: true,
      onSuccess: () => {
        setV({ displayName: '', department: '', email: '' });
        onOpenChange(false);
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>登记无账号成员</DialogTitle>
            <DialogDescription>适合不登录系统的业务提出人。以后发送邀请即可关联账号，历史记录保持不变。</DialogDescription>
          </DialogHeader>
          {(
            [
              ['displayName', '显示名称', true],
              ['department', '部门', false],
              ['email', '邮箱（可选，用于以后邀请）', false],
            ] as const
          ).map(([k, label, required]) => (
            <div key={k} className="flex flex-col gap-1.5">
              <Label htmlFor={`ph-${k}`}>{label}</Label>
              <Input id={`ph-${k}`} required={required} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
            </div>
          ))}
          <FormError error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={m.isPending}>
              登记
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
