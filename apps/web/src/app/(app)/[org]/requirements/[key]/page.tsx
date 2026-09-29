'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api';
import { requirementKeys, useApiMutation, useRequirement } from '@/lib/queries';
import { CheckItems } from './check-items';
import { Comments } from './comments';
import { FieldsPanel } from './fields-panel';
import { History } from './history';
import { SideLists } from './side-lists';
import { StatusPanel } from './status-panel';

export default function RequirementPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const decodedKey = decodeURIComponent(key);
  const router = useRouter();
  const q = useRequirement(org, decodedKey);
  const r = q.data;
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState('');
  const patch = useApiMutation((body: { title?: string; description?: string }) => api(`/orgs/${org}/requirements/${r!.id}`, { method: 'PATCH', body }), {
    invalidate: [requirementKeys(org)],
    success: '已保存',
  });

  useEffect(() => {
    if (r && r.displayKey !== decodedKey) router.replace(`/${org}/requirements/${r.displayKey}`);
  }, [r, decodedKey, org, router]);

  if (q.error instanceof ApiError && q.error.status === 404) return <NoAccess message="需求不存在，或你没有查看它所在产品的权限。" />;
  if (!r) return <Skeleton className="h-64" />;
  const canEdit = r.myRole !== 'viewer';

  return (
    <>
      <PageHeader
        crumbs={[{ label: '需求', href: `/${org}/requirements?product=${r.productKey}` }, { label: r.displayKey }]}
        title={
          editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                patch.mutate({ title }, { onSuccess: () => setEditingTitle(false) });
              }}
            >
              <Input aria-label="标题" className="h-9 text-xl font-semibold" value={title} autoFocus maxLength={200} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} />
            </form>
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              className="text-left disabled:cursor-default"
              onClick={() => {
                setTitle(r.title);
                setEditingTitle(true);
              }}
            >
              <span className="mr-2 font-mono text-base text-muted-foreground">{r.displayKey}</span>
              {r.title}
            </button>
          )
        }
        description={r.aliases.length > 0 ? `旧编号：${r.aliases.join('、')}` : undefined}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-md border bg-card p-4" aria-labelledby="desc-title">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="desc-title" className="text-sm font-semibold">
                描述
              </h2>
              {canEdit && !editingDesc && (
                <button
                  type="button"
                  className="text-[13px] text-primary"
                  onClick={() => {
                    setDescription(r.description);
                    setEditingDesc(true);
                  }}
                >
                  编辑
                </button>
              )}
            </div>
            {editingDesc ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  patch.mutate({ description }, { onSuccess: () => setEditingDesc(false) });
                }}
              >
                <textarea aria-label="描述" className="min-h-48 rounded border bg-background p-2 text-[13px]" value={description} onChange={(e) => setDescription(e.target.value)} />
                <div className="flex justify-end gap-2">
                  <button type="button" className="text-[13px]" onClick={() => setEditingDesc(false)}>
                    取消
                  </button>
                  <button type="submit" className="rounded bg-primary px-3 py-1 text-[13px] text-primary-foreground">
                    保存
                  </button>
                </div>
              </form>
            ) : (
              <p className="whitespace-pre-wrap text-[13px] leading-6">{r.description || <span className="text-muted-foreground">暂无描述</span>}</p>
            )}
          </section>
          <CheckItems org={org} requirement={r} />
          <Comments org={org} requirementId={r.id} />
          <History requirement={r} />
        </div>
        <div className="flex flex-col gap-4">
          <StatusPanel org={org} requirement={r} />
          <FieldsPanel org={org} requirement={r} />
          <SideLists org={org} requirement={r} />
        </div>
      </div>
    </>
  );
}
