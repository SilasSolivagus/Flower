'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { actorLabel, BELL_TABS, type BellTab, groupByDay, relativeTime, unreadBadge } from '@/features/member-notifications/model';
import { api } from '@/lib/api';
import { inboxKeys, useApiMutation, useNotifications, useUnreadCount } from '@/lib/queries';
import type { MemberNotification } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 一条通知：「谁 做了什么」、对象标题、相对时间；未读有圆点。铃铛面板与通知页共用。 */
export function NotificationItem({ n, now, onOpen }: { n: MemberNotification; now: Date; onOpen: (n: MemberNotification) => void }) {
  const actor = actorLabel(n);
  return (
    <button
      type="button"
      aria-label={`${actor} ${n.body}：${n.title}${n.readAt ? '' : '（未读）'}`}
      onClick={() => onOpen(n)}
      className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
    >
      <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-5">
          <span className="font-medium">{actor}</span> {n.body}
        </span>
        <span className="truncate text-[12px] text-muted-foreground">{n.title}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{relativeTime(n.createdAt, now)}</span>
    </button>
  );
}

/** 顶栏铃铛：未读数每 30 秒刷新；面板列出最近 20 条，可切换全部 / 未读 / @我。 */
export function NotificationBell({ org }: { org: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<BellTab>('all');
  const [now, setNow] = useState(() => new Date());
  const count = useUnreadCount(org);
  const list = useNotifications(org, new URLSearchParams({ filter: tab, limit: '20' }).toString(), open);
  const readOne = useApiMutation((id: string) => api(`/orgs/${org}/notifications/${id}/read`, { method: 'POST' }), { invalidate: [inboxKeys(org)], silentError: true });
  const readAll = useApiMutation(() => api(`/orgs/${org}/notifications/read-all`, { method: 'POST' }), { invalidate: [inboxKeys(org)], success: '已全部标为已读' });
  const badge = unreadBadge(count.data ?? 0);
  const items = list.data ?? [];
  const onOpen = (n: MemberNotification) => {
    if (!n.readAt) readOne.mutate(n.id);
    setOpen(false);
    router.push(n.url);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setNow(new Date());
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={badge ? `通知，${count.data} 条未读` : '通知'}>
          <Bell className="size-4" aria-hidden="true" />
          {badge && (
            <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center font-mono text-[10px] leading-4 text-white">
              {badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="通知" className="w-[380px] max-w-[calc(100vw-2rem)] p-0">
        <div role="tablist" aria-label="通知筛选" className="flex gap-1 border-b px-2 py-1.5">
          {BELL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn('rounded-md px-2.5 py-1 text-[13px]', tab === t.key ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="max-h-[420px] overflow-y-auto p-1">
          {list.isError ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">加载通知失败，请稍后再试。</p>
          ) : !list.data ? null : items.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">没有通知</p>
          ) : (
            groupByDay(items, now).map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h3 className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">{g.label}</h3>
                {g.items.map((n) => (
                  <NotificationItem key={n.id} n={n} now={now} onOpen={onOpen} />
                ))}
              </section>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => readAll.mutate(undefined)} disabled={readAll.isPending || !badge}>
            全部标为已读
          </Button>
          <Link href={`/${org}/notifications`} onClick={() => setOpen(false)} className="px-2 text-[13px] text-primary hover:underline">
            查看全部
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
