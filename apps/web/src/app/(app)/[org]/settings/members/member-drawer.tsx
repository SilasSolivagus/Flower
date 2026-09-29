'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { memberKind } from '@/features/members/model';
import { ApiError, api } from '@/lib/api';
import { ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { qk, useFunctionTags, useProducts } from '@/lib/queries';
import type { Member, OrgMe, OrgRole, ProductRole } from '@/lib/types';
import { toast } from 'sonner';

const DEFAULT_ROLE = 'default';

export function MemberDrawer({
  org,
  me,
  member,
  onOpenChange,
  onInvite,
}: {
  org: string;
  me: OrgMe;
  member: Member | null;
  onOpenChange: (v: boolean) => void;
  onInvite: (m: Member) => void;
}) {
  const qc = useQueryClient();
  const tags = useFunctionTags(org);
  const products = useProducts(org);
  const [form, setForm] = useState({ displayName: '', department: '', orgRole: 'member' as OrgRole, status: 'active' as Member['status'] });
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!member) return;
    setForm({ displayName: member.displayName, department: member.department ?? '', orgRole: member.orgRole, status: member.status });
    setTagIds(member.functionTagIds);
    setRoles(Object.fromEntries(member.productRoles.map((r) => [r.productId, r.role])));
    setError(null);
  }, [member]);

  if (!member) return <Sheet open={false} onOpenChange={onOpenChange} />;
  const kind = memberKind(member);
  const isAdminRole = form.orgRole === 'owner' || form.orgRole === 'admin';
  const roleOptions: OrgRole[] = kind === 'agent' ? ['member', 'guest'] : me.orgRole === 'owner' ? ['owner', 'admin', 'member', 'guest'] : ['admin', 'member', 'guest'];

  async function save() {
    if (!member) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/orgs/${org}/members/${member.id}`, {
        method: 'PATCH',
        body: { displayName: form.displayName, department: form.department || null, orgRole: form.orgRole, status: form.status },
      });
      await api(`/orgs/${org}/members/${member.id}/function-tags`, { method: 'PUT', body: { tagIds } });
      if (!isAdminRole && form.status === 'active') {
        for (const p of products.data ?? []) {
          const before = member.productRoles.find((r) => r.productId === p.id)?.role ?? DEFAULT_ROLE;
          const after = roles[p.id] ?? DEFAULT_ROLE;
          if (before !== after) {
            await api(`/orgs/${org}/products/${p.id}/roles/${member.id}`, {
              method: 'PUT',
              body: { role: after === DEFAULT_ROLE ? null : (after as ProductRole) },
            });
          }
        }
      }
      await qc.invalidateQueries({ queryKey: qk.members(org) });
      toast.success('已保存');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'internal', '保存失败，请稍后重试', null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="flex w-[420px] flex-col gap-5 overflow-y-auto sm:max-w-[420px]" aria-describedby="member-drawer-desc">
        <SheetHeader>
          <SheetTitle>{member.displayName}</SheetTitle>
          <SheetDescription id="member-drawer-desc">
            {kind === 'account' ? <span className="font-mono">{member.email}</span> : kind === 'agent' ? 'Agent 成员' : '无账号成员'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4">
          {kind === 'none' && (
            <div className="flex flex-col gap-3 rounded-md bg-amber-50 p-3 text-[13px] text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <p>还没有关联登录账号。发送邀请后，对方注册即可接管这个成员身份，历史记录保持不变。</p>
              <Button variant="outline" size="sm" className="self-start" onClick={() => onInvite(member)}>
                <Link2 className="size-4" aria-hidden="true" />
                发送邀请以关联账号
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-name">显示名称</Label>
              <Input id="md-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-dept">部门</Label>
              <Input id="md-dept" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-role">组织角色</Label>
              <Select value={form.orgRole} onValueChange={(v) => setForm({ ...form, orgRole: v as OrgRole })} disabled={member.orgRole === 'owner' && me.orgRole !== 'owner'}>
                <SelectTrigger id="md-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ORG_ROLE_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-status">状态</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Member['status'] })}>
                <SelectTrigger id="md-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">在职</SelectItem>
                  <SelectItem value="left">已离开</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.status === 'left' && member.status === 'active' && (
            <p className="text-[13px] text-muted-foreground">设为已离开后，会清除该成员的产品角色，并吊销其全部 API Token。</p>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">职能标签</legend>
            <div className="flex flex-wrap gap-3">
              {tags.data?.map((t) => (
                <label key={t.id} className="flex items-center gap-1.5 text-[13px]">
                  <Checkbox
                    aria-label={t.name}
                    checked={tagIds.includes(t.id)}
                    onCheckedChange={(v) => setTagIds(v ? [...tagIds, t.id] : tagIds.filter((x) => x !== t.id))}
                  />
                  <span className="size-2 rounded-full" style={{ background: t.color }} />
                  {t.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-sm font-medium">产品角色</legend>
            <p className="mb-2 text-xs text-muted-foreground">
              {isAdminRole ? '组织管理员在所有产品上都是管理员。' : form.orgRole === 'member' ? '成员默认在所有产品上可编辑，可以按产品调整。' : '访客只能访问被单独授权的产品。'}
            </p>
            {!isAdminRole &&
              products.data?.map((p) => (
                <div key={p.id} className="flex items-center gap-3 border-t py-2">
                  <span className="rounded-sm bg-muted px-1.5 font-mono text-[11px]">{p.key}</span>
                  <span className="flex-1">{p.name}</span>
                  <Select value={roles[p.id] ?? DEFAULT_ROLE} onValueChange={(v) => setRoles({ ...roles, [p.id]: v })}>
                    <SelectTrigger className="h-8 w-28" aria-label={`${p.name} 的产品角色`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_ROLE}>{form.orgRole === 'member' ? '默认（编辑）' : '无权限'}</SelectItem>
                      {(['admin', 'editor', 'viewer'] as const).map((r) => (
                        <SelectItem key={r} value={r}>
                          {PRODUCT_ROLE_LABEL[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
          </fieldset>
          <FormError error={error} />
        </div>
        <SheetFooter className="mt-auto flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={saving}>
            保存
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
