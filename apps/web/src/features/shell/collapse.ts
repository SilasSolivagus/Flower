import { cn } from '@/lib/utils';

/** 桌面侧栏收起。值为 1 表示收到图标轨；缺省或 0 表示展开（约 w-60）。 */
export const NAV_COLLAPSED_KEY = 'flower.shell.navCollapsed';

/** 需求详情右栏收起。值为 1 表示整栏收成把手；缺省或 0 表示展开（380px）。 */
export const REQ_ASIDE_COLLAPSED_KEY = 'flower.req.detail.asideCollapsed';

/** 右栏展开宽度。落在 360–400，取 380。不提供拖拽。 */
export const REQ_ASIDE_EXPANDED_WIDTH = '380px';

/** 展开仍是 w-60（240px）。收起只在 xl（1280）变成 w-14（56px）图标轨，760 抽屉不吃这个宽度。 */
export const NAV_RAIL_CLASS = 'xl:w-14';

export function collapsedFromStorage(value: string | null): boolean {
  return value === '1';
}

export function collapsedToStorage(collapsed: boolean): string {
  return collapsed ? '1' : '0';
}

/** 主导航的 class。收起时仍保留 w-60，只追加 xl:w-14，避免和 760 抽屉抢宽度。 */
export function orgNavClassName(collapsed: boolean, navOpen: boolean): string {
  return cn(
    'z-50 flex h-screen w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-sidebar px-3 py-4',
    'max-xl:fixed max-xl:inset-y-0 max-xl:left-0 max-xl:shadow-lg',
    navOpen ? 'max-xl:flex' : 'max-xl:hidden',
    'xl:sticky xl:top-0 xl:flex',
    collapsed && 'xl:w-14 xl:px-1.5',
  );
}

/** 图标轨上把文字留给读屏，760 抽屉仍显示文字。 */
export function railLabelClassName(collapsed: boolean): string | undefined {
  return collapsed ? 'xl:sr-only' : undefined;
}

/** 图标轨上把图标居中。小于 xl 时不生效。 */
export function railItemClassName(collapsed: boolean): string | undefined {
  return collapsed ? 'xl:justify-center xl:px-0' : undefined;
}

/** 需求详情栅格。展开 380px 右栏；收起只留 2.5rem 把手。小于 lg 仍是单列。 */
export function requirementGridClassName(collapsed: boolean): string {
  return cn('grid grid-cols-1 gap-4', collapsed ? 'lg:grid-cols-[minmax(0,1fr)_2.5rem]' : `lg:grid-cols-[minmax(0,1fr)_${REQ_ASIDE_EXPANDED_WIDTH}]`);
}

/** 主叙事列。窄屏排在右列前面，避免状态和跟进被主列拆开。 */
export function requirementMainClassName(): string {
  return 'order-1 flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1';
}

/**
 * 右列（跟进、状态、历史、其余属性）。
 * lg 起贴在视口顶部下方，栏内过长时自己滚。收起时只留把手，内容另藏。
 */
export function requirementAsideColumnClassName(collapsed: boolean): string {
  return cn(
    'order-2 flex min-h-0 min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:col-start-2 lg:row-start-1 lg:self-start',
    collapsed ? 'lg:items-center lg:border-l' : 'lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto',
  );
}

/** 右列里的卡片。收起时 lg 以上整段隐藏；窄屏仍按文档顺序排在主列后面。 */
export function requirementAsideClassName(collapsed: boolean): string {
  return cn('flex flex-col gap-4', collapsed && 'lg:hidden');
}
