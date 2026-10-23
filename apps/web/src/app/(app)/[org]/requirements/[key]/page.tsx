'use client';

import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Backlinks } from '@/components/backlinks';
import { BlockerList } from '@/components/blocker-list';
import { CheckItems } from '@/components/check-items';
import { EditableTitle } from '@/components/editable-title';
import { FollowButton } from '@/components/follow-button';
import { RequirementTagChips } from '@/features/requirements/tag-chips';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WikiText } from '@/components/wiki-text';
import { WikilinkTextarea } from '@/components/wikilink-textarea';
import { useMarkNotificationsRead } from '@/features/member-notifications/use-mark-read';
import {
  REQ_ASIDE_COLLAPSED_KEY,
  requirementAsideClassName,
  requirementGridClassName,
  requirementStatusBodyClassName,
  requirementStatusColumnClassName,
} from '@/features/shell/collapse';
import { useCollapsedPref } from '@/features/shell/use-collapsed-pref';
import { ProgressList } from '@/features/tracking/components/progress-list';
import { api } from '@/lib/api';
import { documentKeys, iterationKeys, linkKeys, qk, requirementKeys, useApiMutation, useRequirement } from '@/lib/queries';
import { Comments } from './comments';
import { FieldsPanel } from './fields-panel';
import { History } from './history';
import { Assignments } from './assignments';
import { BriefCard } from './brief-card';
import { PrdCard } from './prd-card';
import { Relations } from './relations';
import { Releases } from './releases';
import { SideLists } from './side-lists';
import { StatusPanel } from './status-panel';
import { TrackingPanel } from './tracking-panel';

export default function RequirementPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const decodedKey = decodeURIComponent(key);
  const router = useRouter();
  const q = useRequirement(org, decodedKey);
  const r = q.data;
  useMarkNotificationsRead(org, 'requirement', r?.id);
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState('');
  const [asideCollapsed, setAsideCollapsed] = useCollapsedPref(REQ_ASIDE_COLLAPSED_KEY);
  const patch = useApiMutation((body: { title?: string; description?: string }) => api(`/orgs/${org}/requirements/${r!.id}`, { method: 'PATCH', body }), {
    invalidate: [requirementKeys(org), linkKeys(org)],
    success: '已保存',
  });

  useEffect(() => {
    if (r && r.displayKey !== decodedKey) router.replace(`/${org}/requirements/${r.displayKey}`);
  }, [r, decodedKey, org, router]);

  if (!r && q.isError) {
    return <QueryError error={q.error} noAccessMessage="需求不存在，或你没有查看它所在产品的权限。" retryMessage="加载需求失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!r) return <Skeleton className="h-64" />;
  const canEdit = r.myRole !== 'viewer';

  return (
    <>
      <PageHeader
        crumbs={[{ label: '需求', href: `/${org}/requirements?product=${r.productKey}` }, { label: r.displayKey }]}
        title={<EditableTitle displayKey={r.displayKey} title={r.title} canEdit={canEdit} onSubmit={(title, close) => patch.mutate({ title }, { onSuccess: close })} />}
        description={r.aliases.length > 0 ? `旧编号：${r.aliases.join('、')}` : undefined}
        actions={<FollowButton org={org} type="requirement" id={r.id} />}
      />
      <RequirementTagChips org={org} requirement={r} />
      {!canEdit && (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-[13px] leading-6 text-muted-foreground">
          你是查看者，不能修改这条需求。状态、描述、属性和跟进已锁定；需要修改时请联系产品编辑。评论仍可以发表。
        </p>
      )}
      {/* 右栏整列收起只在 lg 及以上生效。状态历史留在主列，不在这次改动里搬家。 */}
      <div className={requirementGridClassName(asideCollapsed)} data-testid="req-detail-grid" data-aside-collapsed={asideCollapsed ? 'true' : 'false'}>
        <div className={requirementStatusColumnClassName(asideCollapsed)}>
          <Button
            type="button"
            variant="outline"
            size={asideCollapsed ? 'icon-sm' : 'sm'}
            data-testid="req-aside-collapse"
            className={asideCollapsed ? 'sticky top-4 hidden lg:inline-flex' : 'hidden lg:inline-flex lg:self-end'}
            aria-expanded={!asideCollapsed}
            aria-controls="req-detail-aside"
            aria-label={asideCollapsed ? '展开属性栏' : '收起属性栏'}
            title={asideCollapsed ? '展开属性栏' : '收起属性栏'}
            onClick={() => setAsideCollapsed(!asideCollapsed)}
          >
            {asideCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
            <span className={asideCollapsed ? 'sr-only' : undefined}>{asideCollapsed ? '展开属性栏' : '收起属性栏'}</span>
          </Button>
          <div id="req-detail-status" className={requirementStatusBodyClassName(asideCollapsed)}>
            <StatusPanel org={org} requirement={r} />
          </div>
        </div>
        <div className="order-2 flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1" data-testid="req-detail-main">
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
                <WikilinkTextarea org={org} productId={r.productId} aria-label="描述" className="min-h-48 text-[13px]" value={description} onValueChange={setDescription} />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingDesc(false)}>
                    取消
                  </Button>
                  <Button type="submit" size="sm" disabled={patch.isPending}>
                    保存
                  </Button>
                </div>
              </form>
            ) : r.description ? (
              <WikiText org={org} text={r.description} cards={r.links} productKey={r.productKey} productId={r.productId} className="text-[13px] leading-6" />
            ) : (
              <p className="text-[13px] leading-6 text-muted-foreground">暂无描述</p>
            )}
          </section>
          <CheckItems items={r.checkItems} canEdit={canEdit} basePath={`/orgs/${org}/requirements/${r.id}/checks`} invalidate={[requirementKeys(org), qk.workbench]} />
          {r.changeDocument && (
            <CheckItems
              title="PRD 检查项"
              items={r.documentCheckItems}
              canEdit={canEdit}
              basePath={`/orgs/${org}/documents/${r.changeDocument.id}/checks`}
              invalidate={[requirementKeys(org), documentKeys(org), qk.workbench]}
            />
          )}
          <BlockerList org={org} blockers={r.blockers} canEdit={r.myRole !== 'viewer'} addPath={`/orgs/${org}/requirements/${r.id}/blockers`} invalidate={[requirementKeys(org), iterationKeys(org)]} />
          <Relations org={org} requirement={r} />
          <Backlinks org={org} type="requirement" id={r.id} />
          <Tabs defaultValue="comments">
            <TabsList>
              <TabsTrigger value="comments">评论</TabsTrigger>
              <TabsTrigger value="progress">进展记录</TabsTrigger>
            </TabsList>
            <TabsContent value="comments" forceMount className="data-[state=inactive]:hidden">
              <Comments org={org} requirementId={r.id} productId={r.productId} productKey={r.productKey} />
            </TabsContent>
            <TabsContent value="progress" forceMount className="data-[state=inactive]:hidden">
              <ProgressList
                org={org}
                target={{ type: 'requirement', id: r.id, displayKey: r.displayKey, title: r.title, expectedDate: r.tracking.expectedDate, canEditDate: canEdit }}
                canWrite={canEdit}
              />
            </TabsContent>
          </Tabs>
          <History requirement={r} />
        </div>
        <div id="req-detail-aside" data-testid="req-detail-aside" className={requirementAsideClassName(asideCollapsed)}>
          <TrackingPanel org={org} requirement={r} />
          <BriefCard org={org} requirement={r} />
          <PrdCard org={org} requirement={r} />
          <FieldsPanel org={org} requirement={r} />
          <Assignments org={org} requirement={r} />
          <SideLists org={org} requirement={r} />
          <Releases org={org} requirement={r} />
        </div>
      </div>
    </>
  );
}
