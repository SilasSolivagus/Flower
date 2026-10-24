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
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
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
import { Button } from '@/components/ui/button';
import { NAV_COLLAPSED_KEY, orgNavClassName, railItemClassName, railLabelClassName } from '@/features/shell/collapse';
import { activeNavKey, buildNav, type NavIcon, type NavItem } from '@/features/shell/nav';
import { useCollapsedPref } from '@/features/shell/use-collapsed-pref';
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

function NavLink({ item, active, onNavigate, rail }: { item: NavItem; active: boolean; onNavigate?: () => void; rail: boolean }) {
  const Icon = ICONS[item.icon] ?? Blocks;
  const cls = cn('flex h-8 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-sm', railItemClassName(rail));
  const label = <span className={railLabelClassName(rail)}>{item.label}</span>;
  if (!item.href) {
    return (
      <span aria-disabled="true" title={item.label} className={cn(cls, 'cursor-not-allowed text-muted-foreground opacity-60')}>
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      title={item.label}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(cls, active ? 'bg-accent font-semibold text-accent-foreground' : 'text-foreground hover:bg-muted')}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </Link>
  );
}

function NavBody({
  org,
  nav,
  active,
  settingsOpen,
  rail,
  onSettingsOpen,
  onNavigate,
  onClose,
  onToggleRail,
}: {
  org: string;
  nav: ReturnType<typeof buildNav>;
  active: string;
  settingsOpen: boolean;
  rail: boolean;
  onSettingsOpen: () => void;
  onNavigate?: () => void;
  onClose?: () => void;
  onToggleRail: () => void;
}) {
  return (
    <>
      <div className={cn('flex items-center gap-1', rail && 'xl:flex-col xl:gap-2')}>
        <Link href={`/${org}`} onClick={onNavigate} className={cn('flex min-w-0 flex-1 items-center gap-2 px-2 font-bold', rail && 'xl:flex-none', railItemClassName(rail))}>
          <Logo />
          <span className={railLabelClassName(rail)}>Flower</span>
        </Link>
        {onClose && (
          <button type="button" aria-label="收起导航" className="flex size-8 items-center justify-center rounded-md hover:bg-muted xl:hidden" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          data-testid="nav-collapse"
          aria-label={rail ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!rail}
          aria-controls="org-nav"
          title={rail ? '展开侧栏' : '收起侧栏'}
          className={cn('hidden size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted xl:flex', railItemClassName(rail))}
          onClick={onToggleRail}
        >
          {rail ? <PanelLeftOpen className="size-4" aria-hidden="true" /> : <PanelLeftClose className="size-4" aria-hidden="true" />}
        </button>
      </div>
      <OrgSwitcher current={org} rail={rail} />
      <div className="flex flex-col gap-0.5">
        {nav.main.map((i) => (
          <NavLink key={i.key} item={i} active={i.key === active} onNavigate={onNavigate} rail={rail} />
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
            {settingsOpen && nav.settings.map((i) => <NavLink key={i.key} item={i} active={i.key === active} onNavigate={onNavigate} rail={rail} />)}
          </div>
          <div className={cn('hidden flex-col gap-0.5 md:flex', rail && 'xl:mt-2 xl:border-t xl:pt-2')}>
            <div className={cn('px-2.5 pb-1 text-[11px] tracking-widest text-muted-foreground', railLabelClassName(rail))}>组织设置</div>
            {nav.settings.map((i) => (
              <NavLink key={i.key} item={i} active={i.key === active} onNavigate={onNavigate} rail={rail} />
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
  const [navCollapsed, setNavCollapsed] = useCollapsedPref(NAV_COLLAPSED_KEY);
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
        data-testid="org-nav"
        data-collapsed={navCollapsed ? 'true' : 'false'}
        className={orgNavClassName(navCollapsed, navOpen)}
      >
        <NavBody
          org={org}
          nav={nav}
          active={active}
          settingsOpen={settingsOpen}
          rail={navCollapsed}
          onSettingsOpen={() => setSettingsOpen((open) => !open)}
          onNavigate={closeNav}
          onClose={closeNav}
          onToggleRail={() => setNavCollapsed(!navCollapsed)}
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
            <Button variant="ghost" size="sm" className="px-2 text-[13px]" asChild>
              <a href="https://forms.gle/XaEtvkHrRQZePrwL8" target="_blank" rel="noopener noreferrer" aria-label="反馈 Flower 产品">
                <MessageSquarePlus aria-hidden="true" />
                反馈
              </a>
            </Button>
            <NotificationBell org={org} />
            <UserMenu />
          </div>
        </div>
        <main className={shellMainClassName(pathname)}>{children}</main>
      </div>
    </div>
  );
}
