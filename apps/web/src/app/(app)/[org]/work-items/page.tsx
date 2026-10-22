'use client';

import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { activePeople, canListMembers } from '@/features/members/model';
import { CreateWorkItemDialog } from '@/features/tracking/components/work-item-dialog';
import { EMPTY_WORK_ITEM_FILTER, workItemFilterFromParams, workItemListQuery, workItemsHref, type WorkItemListFilter } from '@/features/work-items/model';
import { ApiError } from '@/lib/api';
import { useMembers, useOrg, useProducts, useWorkItems } from '@/lib/queries';

const ALL = '__all';

function day(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

function WorkItemsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const filter = workItemFilterFromParams(params);
  const q = useWorkItems(org, workItemListQuery(filter));
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [creating, setCreating] = useState(false);
  const go = (f: WorkItemListFilter) => router.replace(workItemsHref(org, f), { scroll: false });
  const people = activePeople(members.data ?? []);

  let body;
  if (!q.data) {
    if (q.error instanceof ApiError && q.error.status === 400) {
      body = (
        <EmptyState
          icon={ListChecks}
          title="筛选参数无效"
          description="地址栏里的筛选条件格式不正确。请清除后重新选择。"
          action={
            <Button variant="outline" onClick={() => go(EMPTY_WORK_ITEM_FILTER)}>
              清除筛选
            </Button>
          }
        />
      );
    } else if (q.isError) {
      body = <QueryError error={q.error} noAccessMessage="无法读取工作项列表。" retryMessage="加载工作项失败，请重试。" onRetry={() => q.refetch()} />;
    } else {
      body = <Skeleton className="h-64" />;
    }
  } else if (q.data.length === 0) {
    body = (
      <EmptyState
        icon={ListChecks}
        title="还没有工作项"
        description="技术支持、协调对接等工作可以新建为工作项。当前筛选下没有条目时也是这个空态。"
        action={
          orgQ.data && orgQ.data.me.orgRole !== 'guest' ? (
            <Button onClick={() => setCreating(true)}>新建工作项</Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="overflow-hidden rounded-md border bg-card">
        <Table aria-label="工作项" className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">编号</TableHead>
              <TableHead>标题</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="hidden md:table-cell">负责人</TableHead>
              <TableHead className="hidden md:table-cell">产品</TableHead>
              <TableHead className="hidden md:table-cell">最近进展</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.map((item) => (
              <TableRow key={item.id} className="h-10 even:bg-zebra">
                <TableCell className="font-mono text-xs text-muted-foreground">{item.displayKey}</TableCell>
                <TableCell>
                  <Link href={`/${org}/work-items/${item.displayKey}`} className="block truncate hover:underline">
                    {item.title}
                  </Link>
                </TableCell>
                <TableCell>
                  <span style={{ color: item.stage.color }}>{item.stage.label}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell">{item.owner?.displayName ?? '—'}</TableCell>
                <TableCell className="hidden md:table-cell">{item.product?.name ?? '—'}</TableCell>
                <TableCell className="hidden font-mono text-xs md:table-cell">{day(item.latest?.createdAt ?? null)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '跟进', href: `/${org}/tracking` }, { label: '工作项' }]}
        title="工作项"
        description="组织里的工作项。默认只看进行中，勾选后才包含已完成和已取消，不限时间。"
        actions={
          orgQ.data && orgQ.data.me.orgRole !== 'guest' ? <Button onClick={() => setCreating(true)}>新建工作项</Button> : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Select value={filter.product ?? ALL} onValueChange={(v) => go({ ...filter, product: v === ALL ? null : v })}>
          <SelectTrigger className="h-8 w-40" aria-label="产品">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部产品</SelectItem>
            {(products.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {people.length > 0 && (
          <Select value={filter.owner ?? ALL} onValueChange={(v) => go({ ...filter, owner: v === ALL ? null : v })}>
            <SelectTrigger className="h-8 w-40" aria-label="负责人">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部负责人</SelectItem>
              {people.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(
          [
            ['paused', '只看暂停'],
            ['blocked', '只看有阻塞'],
            ['done', '含已完成'],
            ['canceled', '含已取消'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5">
            <Checkbox checked={filter[key]} onCheckedChange={(on) => go({ ...filter, [key]: on === true })} aria-label={label} />
            {label}
          </label>
        ))}
      </div>
      {body}
      <CreateWorkItemDialog
        org={org}
        products={(products.data ?? []).map((p) => ({ id: p.id, name: p.name }))}
        open={creating}
        onOpenChange={setCreating}
      />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <WorkItemsPage />
    </Suspense>
  );
}
