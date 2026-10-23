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
  Menu,
  RefreshCw,
  SlidersHorizontal,
  Tag,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { activeNavKey, buildNav, type NavIcon, type NavItem } from '@/features/shell/nav';
import { useOrg } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { LoadingBlock, QueryError } from './load-error';
import { Logo } from './logo';
import { NotificationBell } from './notification-bell';
import { OrgSwitcher } from './org-switcher';
import { shellMainClassName } from './shell-width';
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

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = ICONS[item.icon] ?? Blocks;
  const cls = 'flex h-8 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-sm';
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
      onClick={onNavigate}
      className={cn(cls, active ? 'bg-accent font-semibold text-accent-foreground' : 'text-foreground hover:bg-muted')}
    >
      <Icon className="size-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function NavBody({
  org,
  nav,
  active,
  settingsOpen,
  onSettingsOpen,
  onNavigate,
  onClose,
}: {
  org: string;
  nav: ReturnType<typeof buildNav>;
  active: string;
  settingsOpen: boolean;
  onSettingsOpen: () => void;
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Link href={`/${org}`} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-2 px-2 font-bold">
          <Logo />
          Flower
        </Link>
        {onClose && (
          <button type="button" aria-label="收起导航" className="flex size-8 items-center justify-center rounded-md hover:bg-muted xl:hidden" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <OrgSwitcher current={org} />
      <div className="flex flex-col gap-0.5">
        {nav.main.map((i) => (
          <NavLink key={i.key} item={i} active={i.key === active} onNavigate={onNavigate} />
        ))}
      </div>
      {nav.settings.length > 0 && (
        <>
          <div className="flex flex-col gap-0.5 md:hidden">
            <button
              type="button"
              aria-expanded={settingsOpen}
              className="flex h-8 items-center rounded-md px-2.5 text-left text-sm whitespace-nowrap hover:bg-muted"
              onClick={onSettingsOpen}
            >
              组织设置
            </button>
            {settingsOpen && nav.settings.map((i) => <NavLink key={i.key} item={i} active={i.key === active} onNavigate={onNavigate} />)}
          </div>
          <div className="hidden flex-col gap-0.5 md:flex">
            <div className="px-2.5 pb-1 text-[11px] tracking-widest text-muted-foreground">组织设置</div>
            {nav.settings.map((i) => (
              <NavLink key={i.key} item={i} active={i.key === active} onNavigate={onNavigate} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function OrgShell({ children }: { children: ReactNode }) {
  const { org } = useParams<{ org: string }>();
  const pathname = usePathname();
  const q = useOrg(org);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navPath, setNavPath] = useState<string | null>(null);
  const navOpen = navPath === pathname;
  const closeNav = () => setNavPath(null);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavPath(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (!q.data) {
    if (!q.isError) {
      return (
        <div className="flex h-screen items-center justify-center">
          <LoadingBlock className="h-6 w-40" />
        </div>
      );
    }
    return <QueryError error={q.error} noAccessMessage="组织不存在，或者你还不是这个组织的成员。" retryMessage="加载组织失败，请重试。" onRetry={() => q.refetch()} />;
  }
  const nav = buildNav(org, q.data.me.orgRole);
  const active = activeNavKey(pathname, org);
  return (
    <div className="flex min-h-screen">
      {navOpen && (
        <button type="button" aria-label="关闭导航" className="fixed inset-0 z-40 bg-black/40 xl:hidden" onClick={closeNav} />
      )}
      <nav
        id="org-nav"
        aria-label="主导航"
        className={cn(
          'z-50 flex h-screen w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-sidebar px-3 py-4',
          'max-xl:fixed max-xl:inset-y-0 max-xl:left-0 max-xl:shadow-lg',
          navOpen ? 'max-xl:flex' : 'max-xl:hidden',
          'xl:sticky xl:top-0 xl:flex',
        )}
      >
        <NavBody
          org={org}
          nav={nav}
          active={active}
          settingsOpen={settingsOpen}
          onSettingsOpen={() => setSettingsOpen((open) => !open)}
          onNavigate={closeNav}
          onClose={closeNav}
        />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative z-30 flex h-12 items-center gap-2 border-b bg-card px-4 md:px-6">
          <button
            type="button"
            aria-label="打开导航"
            aria-expanded={navOpen}
            aria-controls="org-nav"
            className="flex size-8 items-center justify-center rounded-md hover:bg-muted xl:hidden"
            onClick={() => setNavPath(pathname)}
          >
            <Menu className="size-4" aria-hidden="true" />
          </button>
          <div className="ml-auto flex items-center gap-1">
            <NotificationBell org={org} />
            <UserMenu />
          </div>
        </div>
        <main className={shellMainClassName(pathname)}>{children}</main>
      </div>
    </div>
  );
}
