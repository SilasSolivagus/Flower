'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { ForceJoinDialog } from '@/components/force-join-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { editableIterationProducts } from '@/features/iterations/model';
import { api, unmetFrom } from '@/lib/api';
import { iterationKeys, requirementKeys, useApiMutation, useProducts, useRequirements } from '@/lib/queries';
import type { IterationDetail, RequirementListItem } from '@/lib/types';

export function RequirementsTab({ org, iteration: it }: { org: string; iteration: IterationDetail }) {
  const products = useProducts(org);
  const editable = editableIterationProducts(products.data ?? [], it);
  const joinable = it.status === 'planning' || it.status === 'active';
  const [productId, setProductId] = useState('');
  const picked = editable.find((p) => p.id === productId) ?? editable[0];
  const [q, setQ] = useState('');
  const term = q.trim();
  const search = useRequirements(org, joinable && term ? picked?.id : undefined, `q=${encodeURIComponent(term)}&pageSize=8&sort=updated`);
  const [forcing, setForcing] = useState<RequirementListItem | null>(null);
  const invalidate = [iterationKeys(org), requirementKeys(org)];
  const join = useApiMutation(
    (r: RequirementListItem) => api(`/orgs/${org}/requirements/${r.id}/iteration`, { method: 'PUT', body: { iterationId: it.id } }),
    { invalidate, silentError: true, success: '已加入迭代', onSuccess: () => setQ('') },
  );
  const leave = useApiMutation((requirementId: string) => api(`/orgs/${org}/requirements/${requirementId}/iteration`, { method: 'PUT', body: { iterationId: null } }), {
    invalidate,
    success: '已移出迭代',
  });
  const failed = join.error?.code === 'precondition_failed' ? join.variables : undefined;
  const canForce = !!failed && (products.data ?? []).some((p) => p.id === failed.productId && p.myRole === 'admin');
  const listHref = it.product ? `/${org}/requirements?product=${it.product.key}&iteration=${it.id}` : null;

  return (
    <div className="flex flex-col gap-3">
      {joinable && editable.length > 0 && (
        <section aria-label="添加需求" className="flex flex-col gap-2 rounded-md border bg-card p-3">
          <div className="flex items-center gap-2">
            {!it.product && editable.length > 1 && (
              <Select value={picked?.id} onValueChange={setProductId}>
                <SelectTrigger className="h-8 w-36" aria-label="从产品添加">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {editable.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input aria-label="添加需求" placeholder="输入编号或标题搜索需求" className="h-8 max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {term && (
            <ul className="flex flex-col text-[13px]">
              {(search.data?.items ?? []).map((r) => (
                <li key={r.id} className="flex h-8 items-center gap-2">
                  <span className="font-mono text-muted-foreground">{r.displayKey}</span>
                  <span className="flex-1 truncate">{r.title}</span>
                  {r.iteration?.id === it.id ? (
                    <span className="text-muted-foreground">已在本迭代</span>
                  ) : (
                    <Button size="sm" variant="outline" aria-label={`加入 ${r.displayKey}`} disabled={join.isPending} onClick={() => join.mutate(r)}>
                      {r.iteration ? `从「${r.iteration.name}」移入` : '加入'}
                    </Button>
                  )}
                </li>
              ))}
              {search.data && search.data.items.length === 0 && <li className="text-muted-foreground">没有找到需求</li>}
            </ul>
          )}
          <FormError error={join.error} />
          {failed && canForce && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => setForcing(failed)}>
              强制加入 {failed.displayKey}
            </Button>
          )}
        </section>
      )}
      <ForceJoinDialog
        org={org}
        target={
          forcing && { requirementId: forcing.id, requirementLabel: forcing.displayKey, iterationId: it.id, iterationName: it.name, unmet: unmetFrom(join.error?.details) }
        }
        onClose={() => {
          setForcing(null);
          join.reset();
        }}
      />
      {it.requirements.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">迭代中还没有需求</p>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">编号</TableHead>
                <TableHead>标题</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-28">负责人</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {it.requirements.map((r) => (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-[13px]">{r.displayKey}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Link className="truncate hover:underline" href={`/${org}/requirements/${r.displayKey}`}>
                        {r.title}
                      </Link>
                      {r.activeBlockers > 0 && (
                        <span data-testid="blocker-badge" title="未解除的阻塞项" className="inline-flex items-center gap-1 text-xs text-destructive">
                          <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
                          {r.activeBlockers}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-[13px]">
                      <span className="size-2 rounded-full" style={{ background: r.state.color }} aria-hidden="true" />
                      {r.state.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-[13px]">{r.owner?.displayName ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    {r.canEdit && (
                      <Button variant="ghost" size="sm" aria-label={`移出 ${r.displayKey}`} disabled={leave.isPending} onClick={() => leave.mutate(r.id)}>
                        移出
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {listHref && (
        <Link className="self-start text-[13px] text-primary hover:underline" href={listHref}>
          在需求列表中筛选本迭代
        </Link>
      )}
    </div>
  );
}
