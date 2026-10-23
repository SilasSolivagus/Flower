import { cn } from '@/lib/utils';

/** 桌面侧栏收起。值为 1 表示收到图标轨；缺省或 0 表示展开（约 w-60）。 */
export const NAV_COLLAPSED_KEY = 'flower.shell.navCollapsed';

/** 需求详情右栏收起。值为 1 表示整栏收成把手；缺省或 0 表示展开（320px）。 */
export const REQ_ASIDE_COLLAPSED_KEY = 'flower.req.detail.asideCollapsed';

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

/** 需求详情栅格。展开保持 320px 右栏；收起只留 2.5rem 把手。小于 lg 仍是单列。 */
export function requirementGridClassName(collapsed: boolean): string {
  return cn('grid grid-cols-1 gap-4', collapsed ? 'lg:grid-cols-[minmax(0,1fr)_2.5rem]' : 'lg:grid-cols-[minmax(0,1fr)_320px]');
}

/** 右属性栏。收起时 lg 以上不占格，中间列吃掉宽度。 */
export function requirementAsideClassName(collapsed: boolean): string {
  return cn('order-3 flex flex-col gap-4 lg:col-start-2', collapsed && 'lg:hidden');
}

/**
 * 状态卡所在的右列。收起时这一列变成把手（按钮还在，状态卡隐藏）。
 * 小于 lg 时状态卡仍按原顺序排在主列前面。
 */
export function requirementStatusColumnClassName(collapsed: boolean): string {
  return cn('order-1 flex flex-col gap-3 lg:col-start-2 lg:row-start-1', collapsed && 'lg:items-center lg:border-l');
}

export function requirementStatusBodyClassName(collapsed: boolean): string {
  return collapsed ? 'lg:hidden' : '';
}
