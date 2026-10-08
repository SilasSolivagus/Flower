'use client';

import { DOCUMENT_STATUS_LABELS, DOCUMENT_STATUSES } from '@flower/core/markdown';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  type DocumentListFilter,
  documentFilterToApiQuery,
  documentFilterToSearch,
  documentHref,
  parseDocumentFilter,
  sourceLabel,
} from '@/features/documents/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDateTime } from '@/features/requirements/format';
import { useDocuments, useMembers, useOrg, useProducts } from '@/lib/queries';
import type { DocumentStatus } from '@/lib/types';
import { CreateDocumentDialog } from './create-dialog';

const ALL = '__all';

function DocumentsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = useMemo(() => parseDocumentFilter(new URLSearchParams(searchParams.toString())), [searchParams]);
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const product = products.data?.find((p) => p.key === filter.product) ?? products.data?.[0];
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const list = useDocuments(org, product?.id, documentFilterToApiQuery(filter));
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState(filter.q);
  // 地址栏里的 q 变化时（前进后退）同步到输入框；在渲染期间调整
  const [syncedQ, setSyncedQ] = useState(filter.q);
  if (filter.q !== syncedQ) {
    setSyncedQ(filter.q);
    setQ(filter.q);
  }
  const setFilter = (patch: Partial<DocumentListFilter>) => {
    const qs = documentFilterToSearch({ ...filter, product: product?.key ?? filter.product, ...patch });
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  };

  if (products.isError) return <QueryError error={products.error} noAccessMessage="你没有查看产品的权限。" retryMessage="加载产品失败，请重试。" onRetry={() => products.refetch()} />;
  if (!products.data) return <Skeleton className="h-64" />;
  if (!product) {
    return (
      <>
        <PageHeader title="文档" />
        <EmptyState icon={FileText} title="还没有产品" description="PRD 挂在产品下。请组织管理员先在「组织设置 / 产品」中创建产品。" />
      </>
    );
  }
  const canCreate = product.myRole !== 'viewer';
  const filtered = !!(filter.status || filter.owner || filter.source || filter.q);
  const owner = members.data?.find((m) => m.id === filter.owner) ?? null;

  return (
    <>
      <PageHeader
        title="文档"
        description={`${product.name} · 变更 PRD`}
        actions={
          <>
            {products.data.length > 1 && (
              <Select value={product.key} onValueChange={(key) => router.replace(`?${documentFilterToSearch({ ...filter, product: key })}`)}>
                <SelectTrigger className="h-8 w-40" aria-label="产品">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {products.data.map((p) => (
                    <SelectItem key={p.id} value={p.key}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {canCreate && <Button onClick={() => setCreating(true)}>新建 PRD</Button>}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="min-w-0 flex-1 basis-48"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ q: q.trim() });
          }}
        >
          <Input type="search" aria-label="搜索 PRD" placeholder="按标题、编号或网址搜索，回车确认" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
        </form>
        <Select value={filter.status || ALL} onValueChange={(v) => setFilter({ status: v === ALL ? '' : (v as DocumentStatus) })}>
          <SelectTrigger className="h-8 w-32" aria-label="状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {DOCUMENT_STATUSES.filter((s) => s !== 'merged').map((s) => (
              <SelectItem key={s} value={s}>
                {DOCUMENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.source || ALL} onValueChange={(v) => setFilter({ source: v === ALL ? '' : (v as 'native' | 'external') })}>
          <SelectTrigger className="h-8 w-32" aria-label="来源">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部来源</SelectItem>
            <SelectItem value="native">Flower 文档</SelectItem>
            <SelectItem value="external">外部链接</SelectItem>
          </SelectContent>
        </Select>
        {members.data && (
          <MemberPicker
            label="负责人"
            className="h-8 w-36"
            options={pickerOptions(activePeople(members.data), owner ? { id: owner.id, displayName: owner.displayName } : null)}
            value={filter.owner || null}
            noneLabel="全部负责人"
            placeholder="全部负责人"
            onChange={(id) => setFilter({ owner: id ?? '' })}
          />
        )}
      </div>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="你没有查看这个产品的权限。" retryMessage="加载 PRD 失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-48" />
      ) : list.data.length === 0 ? (
        filtered ? (
          <p className="py-8 text-center text-muted-foreground">没有符合条件的 PRD</p>
        ) : (
          <EmptyState icon={FileText} title="还没有 PRD" description="PRD 可以写在 Flower 里，也可以只登记外部文档的链接。" />
        )
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">编号</TableHead>
                <TableHead className="w-[40%]">标题</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-32">来源</TableHead>
                <TableHead className="w-24">负责人</TableHead>
                <TableHead className="w-20">覆盖需求</TableHead>
                <TableHead className="w-36">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((d) => (
                <TableRow key={d.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-[13px]">
                    <Link href={documentHref(org, d.displayKey)} className="hover:underline">
                      {d.displayKey}
                    </Link>
                  </TableCell>
                  <TableCell className="truncate">
                    <Link href={documentHref(org, d.displayKey)} className="hover:underline">
                      {d.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DocumentStatusBadge status={d.status} />
                  </TableCell>
                  <TableCell className="truncate text-[13px] text-muted-foreground">{sourceLabel(d)}</TableCell>
                  <TableCell className="truncate text-[13px]">{d.owner?.displayName ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px]">{d.requirementCount}</TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">{formatDateTime(d.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <CreateDocumentDialog org={org} productId={product.id} open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <DocumentsPage />
    </Suspense>
  );
}
