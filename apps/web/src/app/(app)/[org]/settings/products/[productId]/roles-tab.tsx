'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { qk, useApiMutation, useMembers, useProductRoles } from '@/lib/queries';
import type { ProductRole } from '@/lib/types';

const DEFAULT = 'default';

export function RolesTab({ org, productId }: { org: string; productId: string }) {
  const members = useMembers(org);
  const roles = useProductRoles(org, productId);
  const set = useApiMutation(
    (v: { memberId: string; role: ProductRole | null }) =>
      api(`/orgs/${org}/products/${productId}/roles/${v.memberId}`, { method: 'PUT', body: { role: v.role } }),
    { invalidate: [qk.productRoles(org, productId), qk.members(org)], success: '已更新' },
  );
  const override = new Map((roles.data ?? []).map((r) => [r.memberId, r.role]));
  const list = (members.data ?? []).filter((m) => m.status === 'active');
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>成员</TableHead>
            <TableHead>组织角色</TableHead>
            <TableHead className="w-48">本产品角色</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((m) => {
            const admin = m.orgRole === 'owner' || m.orgRole === 'admin';
            return (
              <TableRow key={m.id} className="h-10 even:bg-zebra">
                <TableCell className="font-medium">{m.displayName}</TableCell>
                <TableCell>{ORG_ROLE_LABEL[m.orgRole]}</TableCell>
                <TableCell>
                  {admin ? (
                    <span className="text-muted-foreground">管理员（组织管理员）</span>
                  ) : (
                    <Select
                      value={override.get(m.id) ?? DEFAULT}
                      onValueChange={(v) => set.mutate({ memberId: m.id, role: v === DEFAULT ? null : (v as ProductRole) })}
                    >
                      <SelectTrigger className="h-8" aria-label={`${m.displayName} 的产品角色`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT}>{m.orgRole === 'member' ? '默认（编辑）' : '无权限'}</SelectItem>
                        {(['admin', 'editor', 'viewer'] as const).map((r) => (
                          <SelectItem key={r} value={r}>
                            {PRODUCT_ROLE_LABEL[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
