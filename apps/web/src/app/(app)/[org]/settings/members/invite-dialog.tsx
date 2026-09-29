'use client';

import { useState } from 'react';
import { CopyField } from '@/components/copy-field';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Member } from '@/lib/types';

type Role = 'admin' | 'member' | 'guest';

export function InviteDialog({
  org,
  open,
  onOpenChange,
  bindTo,
}: {
  org: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bindTo?: Member | null;
}) {
  const [email, setEmail] = useState(bindTo?.email ?? '');
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<string | null>(null);
  const m = useApiMutation(
    () =>
      api<{ link: string }>(`/orgs/${org}/invitations`, {
        method: 'POST',
        body: { email, orgRole: role, ...(bindTo ? { memberId: bindTo.id } : {}) },
      }),
    { invalidate: [qk.invitations(org)], silentError: true, onSuccess: (d) => setLink(d.link) },
  );
  function close(v: boolean) {
    if (!v) {
      setLink(null);
      setEmail('');
      m.reset();
    }
    onOpenChange(v);
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bindTo ? `邀请 ${bindTo.displayName} 关联账号` : '邀请成员'}</DialogTitle>
          <DialogDescription>邀请链接 7 天内有效。系统暂不发送邮件，请把链接发给对方。</DialogDescription>
        </DialogHeader>
        {link ? (
          <>
            <CopyField label="邀请链接" value={link} />
            <DialogFooter>
              <Button onClick={() => close(false)}>完成</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate(undefined);
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-email">邮箱</Label>
              <Input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-role">组织角色</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">成员（默认可编辑所有产品）</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                  <SelectItem value="guest">访客（只能访问被授权的产品）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FormError error={m.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                取消
              </Button>
              <Button type="submit" disabled={m.isPending}>
                发送邀请
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
