'use client';

import { MailPlus } from 'lucide-react';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { invitationState } from '@/features/members/model';
import { api } from '@/lib/api';
import { ORG_ROLE_LABEL } from '@/lib/labels';
import { qk, useApiMutation, useInvitations } from '@/lib/queries';

const STATE = { pending: '待接受', expired: '已过期', accepted: '已接受', revoked: '已撤销' } as const;

export function InvitationsTab({ org }: { org: string }) {
  const q = useInvitations(org);
  const revoke = useApiMutation((id: string) => api(`/orgs/${org}/invitations/${id}`, { method: 'DELETE' }), {
    invalidate: [qk.invitations(org)],
    success: '邀请已撤销',
  });
  if (!q.data) return null;
  if (q.data.length === 0) return <EmptyState icon={MailPlus} title="还没有发出邀请" />;
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>邮箱</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>有效期至</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.map((i) => {
            const s = invitationState(i);
            return (
              <TableRow key={i.id} className="h-10 even:bg-zebra">
                <TableCell className="font-mono text-xs">{i.email}</TableCell>
                <TableCell>{ORG_ROLE_LABEL[i.orgRole]}</TableCell>
                <TableCell>{STATE[s]}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{i.expiresAt.slice(0, 10)}</TableCell>
                <TableCell className="text-right">
                  {s === 'pending' && (
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          撤销
                        </Button>
                      }
                      title="撤销邀请？"
                      description={`撤销后，发给 ${i.email} 的链接将失效。`}
                      confirmLabel="确认撤销"
                      destructive
                      onConfirm={() => revoke.mutate(i.id)}
                    />
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
