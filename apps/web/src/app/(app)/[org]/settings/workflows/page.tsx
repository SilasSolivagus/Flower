'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { LoadingBlock, QueryError } from '@/components/load-error';
import { NO_PERMISSION_MESSAGE } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { qk, useApiMutation, useWorkflows } from '@/lib/queries';
import type { WorkflowDefinition, WorkflowVersion } from '@/lib/types';

function WorkflowsPage() {
  const { org } = useParams<{ org: string }>();
  const list = useWorkflows(org);
  const templates = (list.data ?? []).filter((w) => w.productId === null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState('');
  const [base, setBase] = useState<string>('');
  const inv = { invalidate: [qk.workflows(org)] };
  const create = useApiMutation(
    async () => {
      const from = base || templates[0]!.id;
      const d = await api<{ definition: WorkflowDefinition; versions: WorkflowVersion[] }>(`/orgs/${org}/workflows/${from}`);
      return api(`/orgs/${org}/workflows`, {
        method: 'POST',
        body: { name, body: d.versions[0]!.body, note: `复制自「${d.definition.name}」v${d.versions[0]!.version}` },
      });
    },
    { ...inv, success: '模板已创建', silentError: true, onSuccess: () => setCreating(false) },
  );
  const update = useApiMutation(
    (v: { id: string; name?: string; archived?: boolean }) =>
      api(`/orgs/${org}/workflows/${v.id}`, { method: 'PATCH', body: { name: v.name, archived: v.archived } }),
    { ...inv, success: '已保存', onSuccess: () => setRenaming(null) },
  );
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '流程模板' }]}
        title="流程模板"
        description="产品从模板中选用一个版本。发布新版本不会影响已在用的产品，产品管理员可以自行切换。"
        actions={
          <Button
            onClick={() => {
              setName('');
              setBase('');
              setCreating(true);
            }}
          >
            新建模板
          </Button>
        }
      />
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage={NO_PERMISSION_MESSAGE} retryMessage="加载流程模板失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <LoadingBlock />
      ) : (
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="w-32">当前版本</TableHead>
              <TableHead className="w-32">状态</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((w) => (
              <TableRow key={w.id} className="h-10 even:bg-zebra">
                <TableCell>
                  <Link href={`/${org}/settings/workflows/${w.id}`} className="font-medium hover:underline">
                    {w.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">v{w.currentVersion}</TableCell>
                <TableCell className="text-muted-foreground">{w.archivedAt ? '已归档' : '启用'}</TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`更多操作：${w.name}`}>
                        <MoreHorizontal className="size-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setName(w.name);
                          setRenaming(w);
                        }}
                      >
                        重命名
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => update.mutate({ id: w.id, archived: !w.archivedAt })}>
                        {w.archivedAt ? '取消归档' : '归档'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      )}
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
              <DialogTitle>新建模板</DialogTitle>
              <DialogDescription>从现有模板的当前版本复制，创建后再编辑。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-name">模板名称</Label>
              <Input id="wf-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-base">复制自</Label>
              <Select value={base || templates[0]?.id} onValueChange={setBase}>
                <SelectTrigger id="wf-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · v{t.currentVersion}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
      <Dialog open={Boolean(renaming)} onOpenChange={(v) => !v && setRenaming(null)}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming) update.mutate({ id: renaming.id, name });
            }}
          >
            <DialogHeader>
              <DialogTitle>重命名模板</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-rename">模板名称</Label>
              <Input id="wf-rename" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={update.isPending}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <WorkflowsPage />
    </RequireOrgAdmin>
  );
}
