'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { documentHref, moduleDocsHref } from '@/features/documents/model';
import { flattenTree, levelLabel, moveSibling } from '@/features/structure/model';
import { api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation, useLevelNames, useModuleDocuments, useNodes } from '@/lib/queries';
import { cn } from '@/lib/utils';

const indent = (depth: number) => ({ paddingLeft: `${(depth - 1) * 24 + 16}px` });

export function StructureTab({ org, productId }: { org: string; productId: string }) {
  const nodes = useNodes(org, productId);
  const levels = useLevelNames(org, productId);
  const moduleDocs = useModuleDocuments(org, productId);
  const docKeyOf = new Map(moduleDocs.data?.groups.flatMap((g) => g.modules.map((m) => [m.node.id, m.document?.displayKey ?? null] as const)) ?? []);
  const [adding, setAdding] = useState<{ parentId: string | null; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const invalidate = [qk.nodes(org, productId), requirementKeys(org), documentKeys(org)];
  const create = useApiMutation((v: { parentId: string | null; name: string }) => api(`/orgs/${org}/products/${productId}/nodes`, { method: 'POST', body: v }), {
    invalidate,
    success: '已新增节点',
    silentError: true,
    onSuccess: () => setAdding(null),
  });
  const rename = useApiMutation((v: { id: string; name: string }) => api(`/orgs/${org}/nodes/${v.id}`, { method: 'PATCH', body: { name: v.name } }), {
    invalidate,
    success: '已保存',
    silentError: true,
    onSuccess: () => setRenaming(null),
  });
  const toggleStatus = useApiMutation(
    (v: { id: string; status: 'active' | 'deprecated' }) => api(`/orgs/${org}/nodes/${v.id}`, { method: 'PATCH', body: { status: v.status } }),
    { invalidate, success: '已保存' },
  );
  const reorder = useApiMutation(
    (v: { parentId: string | null; nodeIds: string[] }) => api(`/orgs/${org}/products/${productId}/nodes/order`, { method: 'PUT', body: v }),
    { invalidate },
  );

  if (nodes.isError) return <LoadError message="加载结构树失败，请重试。" onRetry={() => nodes.refetch()} />;

  const list = flattenTree(nodes.data ?? []);
  const names = levels.data?.names ?? [];
  const siblingIds = (parentId: string | null) => list.filter((x) => x.parentId === parentId).map((x) => x.id);
  const addForm = (parentId: string | null, depth: number) =>
    adding && adding.parentId === parentId ? (
      <form
        className="flex flex-col gap-1 border-b py-2 pr-4"
        style={indent(depth)}
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.name.trim()) create.mutate({ parentId, name: adding.name });
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            aria-label={`新${levelLabel(names, depth)}名称`}
            className="h-8 w-56"
            autoFocus
            maxLength={50}
            value={adding.name}
            onChange={(e) => setAdding({ parentId, name: e.target.value })}
          />
          <Button type="submit" size="sm" disabled={create.isPending}>
            添加
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
            取消
          </Button>
        </div>
        <FormError error={create.error} />
      </form>
    ) : null;

  return (
    <section className="rounded-lg border bg-card" aria-label="结构树">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold">结构树</h2>
        <span className="text-xs text-muted-foreground">层级：{names.join(' / ')}（在「字段与层级」中修改叫法）</span>
      </div>
      <ul>
        {list.map((n) => {
          const siblings = siblingIds(n.parentId);
          const i = siblings.indexOf(n.id);
          const deprecated = n.status === 'deprecated';
          const docKey = docKeyOf.get(n.id);
          return (
            <li key={n.id}>
              <div className={cn('flex min-h-10 flex-wrap items-center gap-2 border-b py-1 pr-4', deprecated && 'text-muted-foreground')} style={indent(n.depth)}>
                <span className="w-14 shrink-0 text-xs text-muted-foreground">{levelLabel(names, n.depth)}</span>
                {renaming?.id === n.id ? (
                  <form
                    className="flex flex-1 flex-col gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename.mutate({ id: n.id, name: renaming.name });
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <Input aria-label="节点名称" className="h-8 w-56" autoFocus maxLength={50} value={renaming.name} onChange={(e) => setRenaming({ id: n.id, name: e.target.value })} />
                      <Button type="submit" size="sm" disabled={rename.isPending}>
                        保存
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                        取消
                      </Button>
                    </div>
                    <FormError error={rename.error} />
                  </form>
                ) : (
                  <>
                    <span className={cn('min-w-0 flex-1 truncate', deprecated && 'line-through')}>
                      {n.name}
                      {deprecated && '（已停用）'}
                    </span>
                    {n.depth === 2 && moduleDocs.data && (
                      <Link
                        href={docKey ? documentHref(org, docKey) : moduleDocsHref(org, moduleDocs.data.productKey, n.id)}
                        aria-label={`${n.name} 的模块文档`}
                        className="shrink-0 truncate font-mono text-[13px] text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {docKey ?? '模块文档'}
                      </Link>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`上移 ${n.name}`}
                      disabled={i === 0 || reorder.isPending}
                      onClick={() => reorder.mutate({ parentId: n.parentId, nodeIds: moveSibling(siblings, n.id, -1) })}
                    >
                      上移
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`下移 ${n.name}`}
                      disabled={i === siblings.length - 1 || reorder.isPending}
                      onClick={() => reorder.mutate({ parentId: n.parentId, nodeIds: moveSibling(siblings, n.id, 1) })}
                    >
                      下移
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`重命名 ${n.name}`} onClick={() => setRenaming({ id: n.id, name: n.name })}>
                      重命名
                    </Button>
                    {n.depth < 3 && !deprecated && (
                      <Button variant="ghost" size="sm" aria-label={`在 ${n.name} 下新增`} onClick={() => setAdding({ parentId: n.id, name: '' })}>
                        新增{levelLabel(names, n.depth + 1)}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${deprecated ? '恢复' : '停用'} ${n.name}`}
                      disabled={toggleStatus.isPending}
                      onClick={() => toggleStatus.mutate({ id: n.id, status: deprecated ? 'active' : 'deprecated' })}
                    >
                      {deprecated ? '恢复' : '停用'}
                    </Button>
                  </>
                )}
              </div>
              {addForm(n.id, n.depth + 1)}
            </li>
          );
        })}
      </ul>
      {list.length === 0 && !adding && <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">还没有节点</p>}
      {addForm(null, 1)}
      {!adding && (
        <div className="px-4 py-3">
          <Button variant="outline" size="sm" onClick={() => setAdding({ parentId: null, name: '' })}>
            新增{levelLabel(names, 1)}
          </Button>
        </div>
      )}
    </section>
  );
}
