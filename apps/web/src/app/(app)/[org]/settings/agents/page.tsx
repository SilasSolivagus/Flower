'use client';

import { Bot } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { DisabledReason } from '@/components/disabled-reason';
import { EmptyState } from '@/components/empty-state';
import { LoadingBlock, QueryError } from '@/components/load-error';
import { NO_PERMISSION_MESSAGE } from '@/components/no-access';
import { FormError } from '@/components/form-error';
import { IssueTokenDialog } from '@/components/issue-token-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeScope, tokenStatus } from '@/features/tokens/model';
import { api } from '@/lib/api';
import { ORG_ROLE_LABEL } from '@/lib/labels';
import { qk, useApiMutation, useMembers, useProducts, useTokens } from '@/lib/queries';

const STATUS = { active: '有效', revoked: '已撤销', expired: '已过期' } as const;
const day = (s: string | null) => (s ? s.slice(0, 10) : '—');

function AgentsPage() {
  const { org } = useParams<{ org: string }>();
  const members = useMembers(org);
  const tokens = useTokens(org);
  const products = useProducts(org);
  const [creating, setCreating] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [name, setName] = useState('');
  const agents = (members.data ?? []).filter((m) => m.kind === 'agent' && m.status === 'active');
  const memberName = new Map((members.data ?? []).map((m) => [m.id, m.displayName]));
  const create = useApiMutation(() => api(`/orgs/${org}/agents`, { method: 'POST', body: { displayName: name } }), {
    invalidate: [qk.members(org)],
    success: 'Agent 已创建',
    silentError: true,
    onSuccess: () => {
      setName('');
      setCreating(false);
    },
  });
  const revoke = useApiMutation((id: string) => api(`/orgs/${org}/tokens/${id}`, { method: 'DELETE' }), {
    invalidate: [qk.tokens(org)],
    success: 'Token 已撤销',
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: 'Agent 与 Token' }]}
        title="Agent 与 Token"
        description="Agent 是一种成员，权限用组织角色和产品角色配置；外部 Agent 使用 Token 调用 API。"
        actions={
          <>
            <Button variant="outline" onClick={() => setCreating(true)}>
              创建 Agent
            </Button>
            <DisabledReason disabled={!!members.data && agents.length === 0} reason="还没有 Agent，不能签发 Token">
              <Button onClick={() => setIssuing(true)} disabled={!members.data || agents.length === 0}>
                签发 Token
              </Button>
            </DisabledReason>
          </>
        }
      />
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Agent</h2>
        {members.isError ? (
          <QueryError error={members.error} noAccessMessage={NO_PERMISSION_MESSAGE} retryMessage="加载成员失败，请重试。" onRetry={() => members.refetch()} />
        ) : !members.data ? (
          <LoadingBlock />
        ) : agents.length === 0 ? (
          <EmptyState icon={Bot} title="还没有 Agent" description="例如「PRD 助手」。创建后可以在成员页调整它的产品角色。" />
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>组织角色</TableHead>
                  <TableHead>有效 Token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((a) => (
                  <TableRow key={a.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-medium">{a.displayName}</TableCell>
                    <TableCell>{ORG_ROLE_LABEL[a.orgRole]}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {(tokens.data ?? []).filter((t) => t.memberId === a.id && tokenStatus(t) === 'active').length}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Token</h2>
        <p className="text-[13px] text-muted-foreground">列表里的前缀不是完整密钥，签发后不能再次查看。完整内容只在签发成功时出现一次，请当场复制。</p>
        {tokens.isError ? (
          <QueryError error={tokens.error} noAccessMessage={NO_PERMISSION_MESSAGE} retryMessage="加载 Token 失败，请重试。" onRetry={() => tokens.refetch()} />
        ) : !tokens.data ? (
          <LoadingBlock />
        ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>持有者</TableHead>
                <TableHead>前缀</TableHead>
                <TableHead>范围</TableHead>
                <TableHead>最近使用</TableHead>
                <TableHead>过期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.data.map((t) => {
                const s = tokenStatus(t);
                return (
                  <TableRow key={t.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>{memberName.get(t.memberId) ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">flw_{t.prefix}_…</TableCell>
                    <TableCell className="text-[13px]">{describeScope(t.scope, products.data ?? [])}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{day(t.lastUsedAt)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{day(t.expiresAt)}</TableCell>
                    <TableCell>{STATUS[s]}</TableCell>
                    <TableCell className="text-right">
                      {s === 'active' && (
                        <ConfirmAction
                          trigger={
                            <Button variant="ghost" size="sm">
                              撤销
                            </Button>
                          }
                          title={`撤销「${t.name}」？`}
                          description="撤销后使用这个 Token 的调用会立即失败，且不能恢复。"
                          confirmLabel="确认撤销"
                          destructive
                          onConfirm={() => revoke.mutate(t.id)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        )}
      </section>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined);
            }}
          >
            <DialogHeader>
              <DialogTitle>创建 Agent</DialogTitle>
              <DialogDescription>Agent 默认是组织成员（在所有产品上可编辑），可以在成员页调整。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ag-name">Agent 名称</Label>
              <Input id="ag-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <FormError error={create.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button type="submit" disabled={create.isPending}>
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <IssueTokenDialog key={agents.length} org={org} open={issuing} onOpenChange={setIssuing} agents={agents} />
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <AgentsPage />
    </RequireOrgAdmin>
  );
}
