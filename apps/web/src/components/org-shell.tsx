'use client';

import {
  Bell,
  Blocks,
  Bot,
  Box,
  Building2,
  ChartColumn,
  ClipboardCheck,
  FileText,
  Home,
  LayoutGrid,
  List,
  ListChecks,
  RefreshCw,
  SlidersHorizontal,
  Tag,
  Users,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { activeNavKey, buildNav, type NavIcon, type NavItem } from '@/features/shell/nav';
import { useOrg } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { QueryError } from './load-error';
import { Logo } from './logo';
import { NotificationBell } from './notification-bell';
import { OrgSwitcher } from './org-switcher';
import { UserMenu } from './user-menu';

const ICONS: Record<NavIcon, typeof Home> = {
  home: Home,
  grid: LayoutGrid,
  list: List,
  cycle: RefreshCw,
  review: ClipboardCheck,
  doc: FileText,
  users: Users,
  tag: Tag,
  box: Box,
  flow: Workflow,
  sliders: SlidersHorizontal,
  bot: Bot,
  building: Building2,
  bell: Bell,
  chart: ChartColumn,
  checklist: ListChecks,
};

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = ICONS[item.icon] ?? Blocks;
  const cls = 'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm';
  if (!item.href) {
    return (
      <span aria-disabled="true" className={cn(cls, 'cursor-not-allowed text-muted-foreground opacity-60')}>
        <Icon className="size-4" aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(cls, active ? 'bg-accent font-semibold text-accent-foreground' : 'text-foreground hover:bg-muted')}
    >
      <Icon className="size-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

export function OrgShell({ children }: { children: ReactNode }) {
  const { org } = useParams<{ org: string }>();
  const pathname = usePathname();
  const q = useOrg(org);
  if (!q.data) {
    if (!q.isError) return null;
    return <QueryError error={q.error} noAccessMessage="组织不存在，或者你还不是这个组织的成员。" retryMessage="加载组织失败，请重试。" onRetry={() => q.refetch()} />;
  }
  const nav = buildNav(org, q.data.me.orgRole);
  const active = activeNavKey(pathname, org);
  return (
    <div className="flex min-h-screen">
      <nav aria-label="主导航" className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-4 border-r bg-sidebar px-3 py-4">
        <Link href={`/${org}`} className="flex items-center gap-2 px-2 font-bold">
          <Logo />
          Flower
        </Link>
        <OrgSwitcher current={org} />
        <div className="flex flex-col gap-0.5">
          {nav.main.map((i) => (
            <NavLink key={i.key} item={i} active={i.key === active} />
          ))}
        </div>
        {nav.settings.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[11px] tracking-widest text-muted-foreground">组织设置</div>
            {nav.settings.map((i) => (
              <NavLink key={i.key} item={i} active={i.key === active} />
            ))}
          </div>
        )}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center justify-end gap-1 border-b bg-card px-6">
          <NotificationBell org={org} />
          <UserMenu />
        </div>
        <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-5 px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
