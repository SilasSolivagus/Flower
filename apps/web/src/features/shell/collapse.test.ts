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
  requirementAsideClassName,
  requirementGridClassName,
  requirementStatusBodyClassName,
  requirementStatusColumnClassName,
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
  it('展开栅格保持 320px，右栏和状态卡都在', () => {
    expect(requirementGridClassName(false)).toBe('grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]');
    expect(requirementAsideClassName(false)).toBe('order-3 flex flex-col gap-4 lg:col-start-2');
    expect(requirementAsideClassName(false)).not.toContain('lg:hidden');
    expect(requirementStatusBodyClassName(false)).toBe('');
    expect(requirementStatusColumnClassName(false)).not.toContain('lg:hidden');
  });

  it('收起后右栏不占格，只留 2.5rem 把手，小于 lg 的单列不受影响', () => {
    const grid = requirementGridClassName(true);
    expect(grid).toContain('grid-cols-1');
    expect(grid).toContain('lg:grid-cols-[minmax(0,1fr)_2.5rem]');
    expect(grid).not.toContain('320px');
    expect(requirementAsideClassName(true).split(/\s+/)).toContain('lg:hidden');
    expect(requirementStatusBodyClassName(true)).toBe('lg:hidden');
    expect(requirementStatusColumnClassName(true)).toContain('lg:col-start-2');
    expect(requirementStatusColumnClassName(true)).not.toContain('lg:hidden');
  });
});
