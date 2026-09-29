import { describe, expect, it } from 'vitest';
import { activeNavKey, buildNav, isOrgAdminRole } from './nav';

describe('buildNav', () => {
  it('管理员看到设置分组，未完成模块带阶段标签且没有链接', () => {
    const nav = buildNav('acme', 'admin');
    expect(nav.main.map((i) => [i.label, i.phase ?? null, i.href ?? null])).toEqual([
      ['概览', null, '/acme'],
      ['需求', 'P1', null],
      ['迭代', 'P1', null],
      ['文档', 'P2', null],
    ]);
    expect(nav.settings.map((i) => i.href)).toEqual([
      '/acme/settings/members',
      '/acme/settings/tags',
      '/acme/settings/products',
      '/acme/settings/workflows',
      '/acme/settings/fields',
      '/acme/settings/agents',
      '/acme/settings/general',
    ]);
  });

  it('成员与访客看不到设置分组', () => {
    expect(buildNav('acme', 'member').settings).toEqual([]);
    expect(buildNav('acme', 'guest').settings).toEqual([]);
    expect(isOrgAdminRole('owner')).toBe(true);
    expect(isOrgAdminRole('member')).toBe(false);
  });

  it('根据路径判断当前导航项', () => {
    expect(activeNavKey('/acme', 'acme')).toBe('home');
    expect(activeNavKey('/acme/settings/members', 'acme')).toBe('members');
    expect(activeNavKey('/acme/settings/workflows/abc', 'acme')).toBe('workflows');
    expect(activeNavKey('/acme/settings/products/1', 'acme')).toBe('products');
  });
});
