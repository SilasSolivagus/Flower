import { describe, expect, it } from 'vitest';
import {
  collapsedFromStorage,
  collapsedToStorage,
  NAV_COLLAPSED_KEY,
  NAV_RAIL_CLASS,
  orgNavClassName,
  railItemClassName,
  railLabelClassName,
  REQ_ASIDE_COLLAPSED_KEY,
  requirementGridClassName,
  requirementMainClassName,
  requirementRailBodyClassName,
  requirementRailClassName,
  trackingBelowMain,
} from './collapse';

describe('收展偏好', () => {
  it('只用约定的 localStorage 键，1 为收起', () => {
    expect(NAV_COLLAPSED_KEY).toBe('flower.shell.navCollapsed');
    expect(REQ_ASIDE_COLLAPSED_KEY).toBe('flower.req.detail.asideCollapsed');
    expect(collapsedFromStorage(null)).toBe(false);
    expect(collapsedFromStorage('0')).toBe(false);
    expect(collapsedFromStorage('true')).toBe(false);
    expect(collapsedFromStorage('1')).toBe(true);
    expect(collapsedToStorage(true)).toBe('1');
    expect(collapsedToStorage(false)).toBe('0');
  });
});

describe('orgNavClassName', () => {
  it('展开仍是 w-60，抽屉关闭时小于 xl 隐藏', () => {
    const cls = orgNavClassName(false, false);
    expect(cls.split(/\s+/)).toContain('w-60');
    expect(cls).not.toContain(NAV_RAIL_CLASS);
    expect(cls).toContain('max-xl:hidden');
    expect(cls).toContain('xl:flex');
    expect(cls).not.toMatch(/(^|\s)w-14(\s|$)/);
  });

  it('收起只在 xl 变成 56px 图标轨，基础宽度仍是 w-60', () => {
    const cls = orgNavClassName(true, false);
    expect(cls.split(/\s+/)).toContain('w-60');
    expect(cls.split(/\s+/)).toContain('xl:w-14');
    expect(cls).not.toMatch(/(^|\s)w-14(\s|$)/);
    expect(cls).toContain('xl:px-1.5');
    expect(cls.split(/\s+/)).toContain('px-3');
  });

  it('抽屉打开时小于 xl 显示，不丢掉桌面定位', () => {
    const cls = orgNavClassName(false, true);
    expect(cls).toContain('max-xl:flex');
    expect(cls).not.toContain('max-xl:hidden');
    expect(cls).toContain('xl:sticky');
  });
});

describe('图标轨文字', () => {
  it('只在收起时于 xl 隐藏文字并居中图标', () => {
    expect(railLabelClassName(false)).toBeUndefined();
    expect(railItemClassName(false)).toBeUndefined();
    expect(railLabelClassName(true)).toBe('xl:sr-only');
    expect(railItemClassName(true)).toBe('xl:justify-center xl:px-0');
  });
});

describe('需求详情右栏', () => {
  it('展开写死 380px，收起仍是 2.5rem，localStorage 键不变', () => {
    expect(requirementGridClassName(false)).toBe('grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]');
    expect(requirementGridClassName(false)).not.toContain('320px');
    const collapsed = requirementGridClassName(true);
    expect(collapsed).toContain('grid-cols-1');
    expect(collapsed).toContain('lg:grid-cols-[minmax(0,1fr)_2.5rem]');
    expect(collapsed).not.toContain('380px');
    expect(collapsed).not.toContain('320px');
  });

  it('单一右轨与主列同一行，跟进不会落到主列之下', () => {
    const rail = requirementRailClassName(false);
    const main = requirementMainClassName();
    expect(rail).toContain('order-1');
    expect(rail).toContain('lg:col-start-2');
    expect(rail).toContain('lg:row-start-1');
    expect(rail).toContain('lg:self-start');
    expect(main).toContain('order-2');
    expect(main).toContain('lg:col-start-1');
    expect(main).toContain('lg:row-start-1');
    expect(trackingBelowMain(rail, main)).toBe(false);
    // PRE-02：状态占 row1，aside 不写 row，自动落到 row2，跟进在主列底边之下。
    expect(trackingBelowMain('order-3 flex flex-col gap-4 lg:col-start-2', 'order-2 flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1')).toBe(true);
    expect(trackingBelowMain('lg:col-start-2 lg:row-start-2', 'lg:col-start-1 lg:row-start-1')).toBe(true);
  });

  it('右轨 sticky、限高、内滚，把手与栏体共用这一层', () => {
    const rail = requirementRailClassName(false);
    expect(rail).toContain('lg:sticky');
    expect(rail).toContain('lg:top-4');
    expect(rail).toContain('lg:max-h-[calc(100vh-2rem)]');
    expect(rail).toContain('lg:overflow-y-auto');
    expect(rail).not.toContain('lg:hidden');
    expect(requirementRailClassName(true)).toContain('lg:sticky');
    expect(requirementRailClassName(true)).not.toContain('lg:hidden');
    expect(requirementRailBodyClassName(false)).not.toContain('lg:hidden');
    expect(requirementRailBodyClassName(true).split(/\s+/)).toContain('lg:hidden');
  });
});
