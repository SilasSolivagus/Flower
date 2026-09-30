'use client';

import { Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ColorSwatches } from '@/components/color-swatches';
import { ConfirmAction } from '@/components/confirm-action';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { SWATCHES } from '@/lib/labels';
import { qk, useApiMutation, useFunctionTags } from '@/lib/queries';
import type { FunctionTag } from '@/lib/types';

function TagsPage() {
  const { org } = useParams<{ org: string }>();
  const tags = useFunctionTags(org);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(SWATCHES[0]!);
  const inv = { invalidate: [qk.tags(org), qk.members(org)] };
  const create = useApiMutation(() => api(`/orgs/${org}/function-tags`, { method: 'POST', body: { name: newName, color: newColor } }), {
    ...inv,
    success: '已添加',
    onSuccess: () => {
      setNewName('');
      setAdding(false);
    },
  });
  const update = useApiMutation(
    (v: { id: string; name?: string; color?: string; sort?: number }) =>
      api(`/orgs/${org}/function-tags/${v.id}`, { method: 'PATCH', body: { name: v.name, color: v.color, sort: v.sort } }),
    { ...inv, success: '已保存' },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/function-tags/${id}`, { method: 'DELETE' }), { ...inv, success: '已删除' });

  async function reorder(next: FunctionTag[]) {
    // 逐个保存排序；某个请求失败时 useApiMutation 已提示原因，停止后续请求
    try {
      for (const [i, t] of next.entries()) {
        if (t.sort !== i) await update.mutateAsync({ id: t.id, sort: i });
      }
    } catch {
      return;
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '职能标签' }]}
        title="职能标签"
        description="职能标签描述成员的岗位，用于指定检查项的签字人和按人筛选，不影响权限。"
        actions={<Button onClick={() => setAdding(true)}>新增标签</Button>}
      />
      {adding && (
        <form
          className="flex items-end gap-3 rounded-lg border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-tag">新标签名称</Label>
            <Input id="new-tag" required value={newName} onChange={(e) => setNewName(e.target.value)} className="w-56" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">颜色</span>
            <ColorSwatches label="新标签颜色" value={newColor} onChange={setNewColor} />
          </div>
          <Button type="submit" disabled={create.isPending}>
            添加
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            取消
          </Button>
        </form>
      )}
      <div className="rounded-lg border bg-card p-2">
        <SortableList
          items={tags.data ?? []}
          getId={(t) => t.id}
          onReorder={reorder}
          renderItem={(t) => (
            <div className="flex h-10 items-center gap-3 border-b last:border-b-0">
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" aria-label={`修改${t.name}的颜色`} className="size-5 rounded-sm" style={{ background: t.color }} />
                </PopoverTrigger>
                <PopoverContent className="w-auto">
                  <ColorSwatches label={`${t.name}的颜色`} value={t.color} onChange={(color) => update.mutate({ id: t.id, color })} />
                </PopoverContent>
              </Popover>
              <Input
                aria-label="标签名称"
                defaultValue={t.name}
                className="h-8 w-64"
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== t.name) update.mutate({ id: t.id, name });
                }}
              />
              <span className="flex-1" />
              <ConfirmAction
                trigger={
                  <Button variant="ghost" size="icon" aria-label={`删除${t.name}`}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                }
                title={`删除「${t.name}」？`}
                description="成员身上的这个标签会一并移除。引用它的检查项签字规则需要重新指定。"
                confirmLabel="确认删除"
                destructive
                onConfirm={() => remove.mutate(t.id)}
              />
            </div>
          )}
        />
      </div>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <TagsPage />
    </RequireOrgAdmin>
  );
}
