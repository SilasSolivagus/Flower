'use client';

import { MEMBER_NOTIFICATION_KIND_LABELS, MEMBER_NOTIFICATION_KINDS } from '@flower/core/notifications';
import { Bell } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadError, LoadingBlock } from '@/components/load-error';
import { NotificationItem } from '@/components/notification-bell';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { groupInbox, type NotificationPageFilter, pageApiQuery, pageUrlQuery, parseNotificationFilter } from '@/features/member-notifications/model';
import { api } from '@/lib/api';
import { inboxKeys, useApiMutation, useNotificationPages } from '@/lib/queries';
import type { MemberNotification } from '@/lib/types';

const ALL_KINDS = 'all';

function NotificationsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const filter = parseNotificationFilter(useSearchParams());
  const [now] = useState(() => new Date());
  const pages = useNotificationPages(org, pageApiQuery(filter));
  const readOne = useApiMutation((id: string) => api(`/orgs/${org}/notifications/${id}/read`, { method: 'POST' }), { invalidate: [inboxKeys(org)], silentError: true });
  const readAll = useApiMutation(() => api(`/orgs/${org}/notifications/read-all`, { method: 'POST' }), { invalidate: [inboxKeys(org)], success: '已全部标为已读' });
  const setFilter = (next: NotificationPageFilter) => {
    const q = pageUrlQuery(next);
    router.replace(q ? `${pathname}?${q}` : pathname);
  };
  const open = (n: MemberNotification) => {
    if (!n.readAt) readOne.mutate(n.id);
    router.push(n.url);
  };
  const items = pages.data?.pages.flatMap((p) => p.notifications) ?? [];
  return (
    <>
      <PageHeader
        crumbs={[{ label: '通知' }]}
        title="通知"
        description="要你做的事排在前面，其余是关注动态和系统告警。通知偏好在个人设置里修改。"
        actions={
          <Button variant="outline" onClick={() => readAll.mutate(undefined)} disabled={readAll.isPending}>
            全部标为已读
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter.kind || ALL_KINDS} onValueChange={(v) => setFilter({ ...filter, kind: v === ALL_KINDS ? '' : (v as NotificationPageFilter['kind']) })}>
          <SelectTrigger className="w-36" aria-label="按类型筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_KINDS}>全部类型</SelectItem>
            {MEMBER_NOTIFICATION_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {MEMBER_NOTIFICATION_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.read} onValueChange={(v) => setFilter({ ...filter, read: v as NotificationPageFilter['read'] })}>
          <SelectTrigger className="w-28" aria-label="按已读状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="unread">未读</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {pages.isError ? (
        <LoadError message="加载通知失败，请重试。" onRetry={() => pages.refetch()} />
      ) : !pages.data ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState icon={Bell} title="没有通知" description="被 @、被指派，或关注的需求与 PRD 有变化时会出现在这里。" />
      ) : (
        <div className="flex flex-col gap-5">
          {groupInbox(items).map((section) => (
            <section key={section.label} aria-label={section.label} className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">{section.label}</h2>
              <ul aria-label={section.label} className="flex flex-col divide-y rounded-md border bg-card">
                {section.items.map((n) => (
                  <li key={n.id} className="px-1 py-0.5">
                    <NotificationItem n={n} now={now} onOpen={open} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {pages.hasNextPage && (
        <Button variant="outline" className="self-center" onClick={() => pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
          加载更多
        </Button>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <NotificationsPage />
    </Suspense>
  );
}
