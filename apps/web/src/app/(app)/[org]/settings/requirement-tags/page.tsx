'use client';

import { Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ColorSwatches } from '@/components/color-swatches';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadingBlock, QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { SWATCHES } from '@/lib/labels';
import { qk, useApiMutation, useRequirementTags } from '@/lib/queries';

export default function RequirementTagsPage() {
  const { org } = useParams<{ org: string }>();
  const tags = useRequirementTags(org);
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]!);
  const inv = { invalidate: [qk.requirementTags(org)] };
  const create = useApiMutation(() => api(`/orgs/${org}/requirement-tags`, { method: 'POST', body: { name, color } }), {
    ...inv,
    success: '已添加',
    onSuccess: () => setName(''),
  });
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/requirement-tags/${id}`, { method: 'DELETE' }), { ...inv, success: '已删除' });

  return (
    <RequireOrgAdmin>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '需求标签' }]}
        title="需求标签"
        description="需求标签挂在需求上，和职能标签不是一回事。删除后会从仍在使用它的需求上卸下。"
      />
      <form
        className="flex items-end gap-3 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="req-tag-name">新标签名称</Label>
          <Input id="req-tag-name" required value={name} onChange={(e) => setName(e.target.value)} className="w-56" maxLength={20} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">颜色</span>
          <ColorSwatches label="新标签颜色" value={color} onChange={setColor} />
        </div>
        <Button type="submit" disabled={create.isPending}>
          添加
        </Button>
      </form>
      {!tags.data ? (
        tags.isError ? (
          <QueryError error={tags.error} noAccessMessage="无权查看需求标签。" retryMessage="加载需求标签失败，请重试。" onRetry={() => tags.refetch()} />
        ) : (
          <LoadingBlock />
        )
      ) : tags.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有需求标签</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {tags.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
              <span className="size-3 rounded-full" style={{ background: t.color }} />
              <span className="flex-1">{t.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{t.usageCount}</span>
              <ConfirmAction
                trigger={
                  <Button variant="ghost" size="icon" aria-label={`删除 ${t.name}`}>
                    <Trash2 className="size-4" />
                  </Button>
                }
                title={`删除「${t.name}」？`}
                description={`会从 ${t.usageCount} 个需求上移除`}
                confirmLabel="删除"
                destructive
                onConfirm={() => remove.mutate(t.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </RequireOrgAdmin>
  );
}
