'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Member } from '@/lib/types';

/** 组织管理员修改一个成员的企业微信账号（userid）；留空表示解除。父组件按成员 id 设 key 挂载。 */
export function WecomUseridDialog({ org, member, onClose }: { org: string; member: Member; onClose: () => void }) {
  const [value, setValue] = useState(member.wecomUserid ?? '');
  const save = useApiMutation(() => api(`/orgs/${org}/members/${member.id}/wecom`, { method: 'PUT', body: { userid: value.trim() || null } }), {
    invalidate: [qk.members(org)],
    success: '已保存',
    silentError: true,
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{member.displayName}的企业微信账号</DialogTitle>
            <DialogDescription>填写企业微信通讯录里的账号（userid），群里的个人提醒会 @ 到本人。留空表示解除。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wecom-userid">企业微信账号</Label>
            <Input id="wecom-userid" value={value} maxLength={64} className="font-mono" onChange={(e) => setValue(e.target.value)} />
          </div>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
