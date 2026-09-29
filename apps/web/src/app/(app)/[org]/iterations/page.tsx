'use client';

import { CalendarRange } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { groupIterations } from '@/features/iterations/model';
import { isOrgAdminRole } from '@/features/shell/nav';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import { useIterations, useOrg, useProducts } from '@/lib/queries';
import type { Iteration } from '@/lib/types';
import { IterationDialog } from './iteration-dialog';

export default function IterationsPage() {
  const { org } = useParams<{ org: string }>();
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const q = useIterations(org);
  const [dialog, setDialog] = useState<{ open: boolean; iteration: Iteration | null }>({ open: false, iteration: null });
  const orgAdmin = !!orgQ.data && isOrgAdminRole(orgQ.data.me.orgRole);
  const adminProducts = (products.data ?? []).filter((p) => p.myRole === 'admin');
  const canCreate = orgAdmin || adminProducts.length > 0;

  if (q.isError) {
    return (
      <>
        <PageHeader title="迭代" />
        <LoadError message="加载迭代失败，请重试。" onRetry={() => q.refetch()} />
      </>
    );
  }

  const groups = groupIterations(q.data ?? []);
  return (
    <>
      <PageHeader
        title="迭代"
        description="常规迭代属于产品，同一产品内时间不重叠；专项属于组织，可以跨产品。"
        actions={canCreate && <Button onClick={() => setDialog({ open: true, iteration: null })}>新建迭代</Button>}
      />
      {!q.data ? (
        <Skeleton className="h-40" />
      ) : groups.length === 0 ? (
        <EmptyState icon={CalendarRange} title="还没有迭代" description={canCreate ? '点击「新建迭代」创建第一个迭代。' : '产品管理员创建迭代后会显示在这里。'} />
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.title} className="flex flex-col gap-2">
            <h2 className="font-semibold">{g.title}</h2>
            <div className="overflow-hidden rounded-md border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead className="w-56">日期</TableHead>
                    <TableHead className="w-24">状态</TableHead>
                    <TableHead className="w-20 text-right">需求</TableHead>
                    <TableHead className="w-20 text-right">已完成</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.iterations.map((it) => (
                    <TableRow key={it.id} className="h-10 even:bg-zebra">
                      <TableCell>
                        <Link className="font-medium hover:underline" href={`/${org}/iterations/${it.id}`}>
                          {it.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">
                        {it.startDate} ~ {it.endDate}
                      </TableCell>
                      <TableCell className="text-[13px]">{ITERATION_STATUS_LABEL[it.status]}</TableCell>
                      <TableCell className="text-right font-mono">{it.requirementCount}</TableCell>
                      <TableCell className="text-right font-mono">{it.doneCount}</TableCell>
                      <TableCell className="text-right">
                        {it.canManage && (it.status === 'planning' || it.status === 'active') && (
                          <Button variant="ghost" size="sm" aria-label={`编辑 ${it.name}`} onClick={() => setDialog({ open: true, iteration: it })}>
                            编辑
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ))
      )}
      <IterationDialog
        org={org}
        open={dialog.open}
        iteration={dialog.iteration}
        products={adminProducts}
        allowSpecial={orgAdmin}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </>
  );
}
