'use client';

import { ListTodo, Search } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadingBlock, QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { OptionMultiSelect } from '@/components/option-multi-select';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { filterToApiQuery, filterToSearch, type ListFilter, parseFilter, patchFilter, requirementFilterActive } from '@/features/requirements/filter';
import { SORT_LABEL } from '@/lib/labels';
import { useFields, useMembers, useNodes, useOrg, useProductIterations, useProducts, useProductWorkflow, useRequirements } from '@/lib/queries';
import type { RequirementListItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CreateRequirementDialog } from './create-dialog';

const ALL = '__all';

function StateBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function RequirementsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = useMemo(() => parseFilter(new URLSearchParams(searchParams.toString())), [searchParams]);
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const product = products.data?.find((p) => p.key === filter.product) ?? products.data?.[0];
  const workflow = useProductWorkflow(org, product?.id ?? '');
  const fields = useFields(org, product?.id);
  const canListMembersFlag = canListMembers(orgQ.data?.me);
  const members = useMembers(org, canListMembersFlag);
  const nodes = useNodes(org, product?.id);
  const iterations = useProductIterations(org, product?.id);
  const data = useRequirements(org, product?.id, filterToApiQuery(filter));
  const [q, setQ] = useState(filter.q);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setFilter = (patch: Partial<ListFilter>) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const next = patchFilter({ ...filter, product: product?.key ?? filter.product, q }, patch);
    const qs = filterToSearch(next);
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  };

  // 地址栏里的 q 变化时（前进后退、清空筛选）同步到输入框；在渲染期间调整，避免 effect 里 setState 多渲染一轮
  const [syncedQ, setSyncedQ] = useState(filter.q);
  if (filter.q !== syncedQ) {
    setSyncedQ(filter.q);
    setQ(filter.q);
  }
  useEffect(() => {
    if (q === filter.q) return;
    debounceRef.current = setTimeout(() => setFilter({ q }), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  if (products.isError) {
    return (
      <>
        <PageHeader title="需求" />
        <QueryError error={products.error} noAccessMessage="你没有查看产品的权限。" retryMessage="加载产品失败，请重试。" onRetry={() => products.refetch()} />
      </>
    );
  }
  if (!products.data) {
    return (
      <>
        <PageHeader title="需求" />
        <LoadingBlock />
      </>
    );
  }
  if (products.data.length === 0) {
    return (
      <>
        <PageHeader title="需求" />
        <EmptyState icon={ListTodo} title="还没有产品" description="需求挂在产品下。请组织管理员先在「组织设置 / 产品」中创建产品。" />
      </>
    );
  }

  const states = workflow.data ? [...workflow.data.version.body.states].sort((a, b) => a.order - b.order) : [];
  const stateOf = new Map(states.map((s) => [s.key, s]));
  const counts = data.data?.stateCounts ?? {};
  const allCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const priority = fields.data?.find((f) => f.key === 'priority');
  const platform = fields.data?.find((f) => f.key === 'platform');
  const topNodes = (nodes.data ?? []).filter((n) => n.depth === 1);
  const total = data.data?.total ?? 0;
  const pageSize = data.data?.pageSize ?? 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const canCreate = product && product.myRole !== 'viewer';

  return (
    <>
      <PageHeader
        title="需求"
        description={product ? `${product.name} · 共 ${allCount} 条` : undefined}
        actions={
          <>
            {products.data && products.data.length > 1 && (
              <Select value={product?.key} onValueChange={(key) => router.replace(`?${filterToSearch({ ...filter, product: key, page: 1 })}`)}>
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
            {canCreate && <Button onClick={() => setCreating(true)}>新建需求</Button>}
          </>
        }
      />

      <div role="tablist" aria-label="状态" className="flex flex-wrap gap-1 border-b">
        {[{ key: ALL, label: '全部', color: '' }, ...states].map((s) => {
          const active = s.key === ALL ? filter.states.length === 0 : filter.states.length === 1 && filter.states[0] === s.key;
          const n = s.key === ALL ? allCount : (counts[s.key] ?? 0);
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter({ states: s.key === ALL ? [] : [s.key] })}
              className={cn('-mb-px flex h-9 items-center gap-1.5 border-b-2 px-3 text-[13px]', active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {s.label}
              <span className="font-mono text-xs">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-2 size-4 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="搜索需求" placeholder="标题、编号或旧编号" className="h-8 w-60 pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {priority && (
          <OptionMultiSelect label="优先级" options={priority.options.map((o) => ({ id: o.id, label: o.label, color: o.color }))} value={filter.priority} onChange={(v) => setFilter({ priority: v })} />
        )}
        {platform && platform.options.length > 0 && (
          <OptionMultiSelect label="平台" options={platform.options.map((o) => ({ id: o.id, label: o.label, color: o.color }))} value={filter.platform} onChange={(v) => setFilter({ platform: v })} />
        )}
        {topNodes.length > 0 && (
          <Select value={filter.node ?? ALL} onValueChange={(v) => setFilter({ node: v === ALL ? null : v })}>
            <SelectTrigger className="h-8 w-36" aria-label="业务域">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部业务域</SelectItem>
              {topNodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {canListMembersFlag && members.data && (
          <MemberPicker
            label="负责人"
            className="h-8 w-32"
            noneLabel="全部负责人"
            options={pickerOptions(activePeople(members.data), null)}
            value={filter.owner}
            onChange={(id) => setFilter({ owner: id })}
          />
        )}
        <Select value={filter.iteration ?? ALL} onValueChange={(v) => setFilter({ iteration: v === ALL ? null : v })}>
          <SelectTrigger className="h-8 w-36" aria-label="迭代">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部迭代</SelectItem>
            <SelectItem value="none">未排期</SelectItem>
            {(iterations.data ?? []).map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.sort} onValueChange={(v) => setFilter({ sort: v as ListFilter['sort'] })}>
          <SelectTrigger className="ml-auto h-8 w-32" aria-label="排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABEL) as Array<keyof typeof SORT_LABEL>).map((k) => (
              <SelectItem key={k} value={k}>
                {SORT_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!data.data && data.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-md border bg-card px-4 py-10 text-center">
          <p className="text-[13px] text-muted-foreground">加载需求列表失败，请重试。</p>
          <Button variant="outline" size="sm" onClick={() => data.refetch()}>
            重试
          </Button>
        </div>
      ) : !data.data ? (
        <LoadingBlock />
      ) : (
      <div className="overflow-x-auto rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">编号</TableHead>
              <TableHead className="min-w-[14rem]">标题</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="hidden w-20 md:table-cell">优先级</TableHead>
              <TableHead className="hidden w-40 xl:table-cell">平台</TableHead>
              <TableHead className="hidden w-28 xl:table-cell">业务域</TableHead>
              <TableHead className="hidden w-20 md:table-cell">负责人</TableHead>
              <TableHead className="hidden w-20 xl:table-cell">提出人</TableHead>
              <TableHead className="hidden w-28 xl:table-cell">迭代</TableHead>
              <TableHead className="hidden w-24 xl:table-cell">更新</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data.data?.items ?? []).map((r: RequirementListItem) => {
              const s = stateOf.get(r.stateKey);
              return (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-xs">
                    {r.displayKey}
                    {r.legacyKey && <div className="text-[11px] text-muted-foreground">{r.legacyKey}</div>}
                  </TableCell>
                  <TableCell className="min-w-[14rem] whitespace-normal break-words">
                    <Link href={`/${org}/requirements/${r.displayKey}`} className="hover:underline">
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>{s ? <StateBadge label={s.label} color={s.color} /> : r.stateKey}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {r.priority && (
                      <Badge variant="outline" style={{ borderColor: r.priority.color ?? undefined, color: r.priority.color ?? undefined }}>
                        {r.priority.label}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden truncate text-[13px] text-muted-foreground xl:table-cell">{r.platforms.map((p) => p.label).join('、')}</TableCell>
                  <TableCell className="hidden truncate text-[13px] xl:table-cell">{r.node?.name}</TableCell>
                  <TableCell className="hidden truncate text-[13px] md:table-cell">{r.owner?.displayName}</TableCell>
                  <TableCell className="hidden truncate text-[13px] text-muted-foreground xl:table-cell">{r.requester?.displayName}</TableCell>
                  <TableCell className="hidden truncate text-[13px] xl:table-cell">{r.iteration?.name}</TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground xl:table-cell">{new Date(r.updatedAt).toLocaleDateString('zh-CN')}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {data.data.items.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">没有符合条件的需求</p>
            {requirementFilterActive(filter) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQ('');
                  setFilter({ states: [], node: null, priority: [], platform: [], owner: null, iteration: null, q: '', page: 1 });
                }}
              >
                清除筛选
              </Button>
            )}
          </div>
        )}
        {data.isError && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">加载需求列表失败，请重试。</p>
            <Button variant="outline" size="sm" onClick={() => data.refetch()}>
              重试
            </Button>
          </div>
        )}
      </div>
      )}

      <div className="flex items-center justify-end gap-2 text-[13px] text-muted-foreground">
        <span>
          共 {total} 条 · 第 {filter.page} / {pages} 页
        </span>
        <Button variant="outline" size="sm" disabled={filter.page <= 1} onClick={() => setFilter({ page: filter.page - 1 })}>
          上一页
        </Button>
        <Button variant="outline" size="sm" disabled={filter.page >= pages} onClick={() => setFilter({ page: filter.page + 1 })}>
          下一页
        </Button>
      </div>

      {product && <CreateRequirementDialog org={org} productId={product.id} open={creating} onOpenChange={setCreating} />}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RequirementsPage />
    </Suspense>
  );
}
