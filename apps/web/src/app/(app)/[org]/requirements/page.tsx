'use client';

import { ListTodo, Search } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { OptionMultiSelect } from '@/components/option-multi-select';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { filterToApiQuery, filterToSearch, type ListFilter, parseFilter, patchFilter } from '@/features/requirements/filter';
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
  const canListMembers = !!orgQ.data && orgQ.data.me.orgRole !== 'guest';
  const members = useMembers(org, canListMembers);
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

  useEffect(() => setQ(filter.q), [filter.q]);
  useEffect(() => {
    if (q === filter.q) return;
    debounceRef.current = setTimeout(() => setFilter({ q }), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  if (products.data && products.data.length === 0) {
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
        {canListMembers && members.data && (
          <Select value={filter.owner ?? ALL} onValueChange={(v) => setFilter({ owner: v === ALL ? null : v })}>
            <SelectTrigger className="h-8 w-32" aria-label="负责人">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部负责人</SelectItem>
              {members.data
                .filter((m) => m.status === 'active' && m.kind === 'human')
                .map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
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

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">编号</TableHead>
              <TableHead>标题</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-20">优先级</TableHead>
              <TableHead className="w-40">平台</TableHead>
              <TableHead className="w-28">业务域</TableHead>
              <TableHead className="w-20">负责人</TableHead>
              <TableHead className="w-20">提出人</TableHead>
              <TableHead className="w-28">迭代</TableHead>
              <TableHead className="w-24">更新</TableHead>
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
                  <TableCell className="max-w-0">
                    <Link href={`/${org}/requirements/${r.displayKey}`} className="block truncate hover:underline">
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>{s ? <StateBadge label={s.label} color={s.color} /> : r.stateKey}</TableCell>
                  <TableCell>
                    {r.priority && (
                      <Badge variant="outline" style={{ borderColor: r.priority.color ?? undefined, color: r.priority.color ?? undefined }}>
                        {r.priority.label}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="truncate text-[13px] text-muted-foreground">{r.platforms.map((p) => p.label).join('、')}</TableCell>
                  <TableCell className="truncate text-[13px]">{r.node?.name}</TableCell>
                  <TableCell className="truncate text-[13px]">{r.owner?.displayName}</TableCell>
                  <TableCell className="truncate text-[13px] text-muted-foreground">{r.requester?.displayName}</TableCell>
                  <TableCell className="truncate text-[13px]">{r.iteration?.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{new Date(r.updatedAt).toLocaleDateString('zh-CN')}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {data.data && data.data.items.length === 0 && <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">没有符合条件的需求</p>}
      </div>

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
