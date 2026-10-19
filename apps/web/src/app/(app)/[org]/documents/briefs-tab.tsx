'use client';

import { BRIEF_STATUSES, DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type BriefListFilter, briefFilterSummary, briefFilterToApiQuery, documentHref, gateLabel } from '@/features/documents/model';
import { activePeople, pickerOptions } from '@/features/members/model';
import { formatDateTime } from '@/features/requirements/format';
import { useBriefs } from '@/lib/queries';
import type { BriefStatus, Member, Product } from '@/lib/types';

const ALL = '__all';

/** 文档页「简报」页签：按状态、确认人筛选（写在地址栏），列出编号、标题、状态、关联需求、检查进度、确认人、更新时间。 */
export function BriefsTab({
  org,
  product,
  filter,
  onFilter,
  members,
}: {
  org: string;
  product: Product;
  filter: BriefListFilter;
  onFilter: (patch: Partial<BriefListFilter>) => void;
  members: Member[] | undefined;
}) {
  const list = useBriefs(org, briefFilterToApiQuery(filter, product.id));
  const decider = members?.find((m) => m.id === filter.decider) ?? null;
  const filtered = !!(filter.status || filter.decider);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter.status || ALL} onValueChange={(v) => v && onFilter({ status: v === ALL ? '' : (v as BriefStatus) })}>
          <SelectTrigger className="h-8 w-32" aria-label="状态">
            <SelectValue>{filter.status ? DOCUMENT_STATUS_LABELS[filter.status] : '全部状态'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {BRIEF_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {DOCUMENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {members && (
          <MemberPicker
            label="确认人"
            className="h-8 w-36"
            options={pickerOptions(activePeople(members), decider ? { id: decider.id, displayName: decider.displayName } : null)}
            value={filter.decider || null}
            noneLabel="全部确认人"
            placeholder="全部确认人"
            onChange={(id) => onFilter({ decider: id ?? '' })}
          />
        )}
      </div>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="你没有查看这个产品的权限。" retryMessage="加载简报失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-48" />
      ) : list.data.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={FileText}
            title="没有符合条件的简报"
            description={`当前筛选：${briefFilterSummary(filter, decider?.displayName ?? null)}`}
            action={
              <Button variant="outline" size="sm" onClick={() => onFilter({ status: '', decider: '' })}>
                清除筛选
              </Button>
            }
          />
        ) : (
          <EmptyState icon={FileText} title="还没有简报" description="写 PRD 之前，把查代码、取数、可行性与方案讨论的结论按模板记在简报里。" />
        )
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table className="min-w-[960px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">编号</TableHead>
                <TableHead className="min-w-[12rem]">标题</TableHead>
                <TableHead className="w-32">状态</TableHead>
                <TableHead className="w-24">关联需求</TableHead>
                <TableHead className="w-40">检查</TableHead>
                <TableHead className="w-24">确认人</TableHead>
                <TableHead className="w-36">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((b) => (
                <TableRow key={b.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-[13px]">
                    <Link href={documentHref(org, b.displayKey)} className="hover:underline">
                      {b.displayKey}
                    </Link>
                  </TableCell>
                  <TableCell className="min-w-[12rem] truncate">
                    <Link href={documentHref(org, b.displayKey)} className="hover:underline">
                      {b.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DocumentStatusBadge status={b.status} />
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{b.requirementCount}</TableCell>
                  <TableCell className="whitespace-normal font-mono text-[13px]">{gateLabel(b.gate)}</TableCell>
                  <TableCell className="truncate text-[13px]" title={b.decider?.displayName}>
                    {b.decider?.displayName ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">{formatDateTime(b.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
