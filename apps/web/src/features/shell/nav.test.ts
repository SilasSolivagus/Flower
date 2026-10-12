import { describe, expect, it } from 'vitest';
import { activeNavKey, buildNav, isOrgAdminRole } from './nav';

describe('buildNav', () => {
  it('管理员看到设置分组，各导航项都有链接', () => {
    const nav = buildNav('acme', 'admin');
    expect(nav.main.map((i) => [i.label, i.href ?? null])).toEqual([
      ['工作台', '/acme'],
      ['概览', '/acme/overview'],
      ['需求', '/acme/requirements'],
      ['迭代', '/acme/iterations'],
      ['评审', '/acme/reviews'],
      ['文档', '/acme/documents'],
    ]);
    expect(nav.settings.map((i) => i.href)).toEqual([
      '/acme/settings/members',
      '/acme/settings/tags',
      '/acme/settings/products',
      '/acme/settings/workflows',
      '/acme/settings/fields',
      '/acme/settings/templates',
      '/acme/settings/agents',
      '/acme/settings/notifications',
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
    expect(activeNavKey('/acme/settings/templates', 'acme')).toBe('templates');
    expect(activeNavKey('/acme/settings/products/1', 'acme')).toBe('products');
    expect(activeNavKey('/acme/requirements', 'acme')).toBe('requirements');
    expect(activeNavKey('/acme/requirements/PAN-12', 'acme')).toBe('requirements');
    expect(activeNavKey('/acme/iterations', 'acme')).toBe('iterations');
    expect(activeNavKey('/acme/iterations/abc', 'acme')).toBe('iterations');
    expect(activeNavKey('/acme/workload', 'acme')).toBe('iterations');
    expect(activeNavKey('/acme/reviews', 'acme')).toBe('reviews');
    expect(activeNavKey('/acme/overview', 'acme')).toBe('overview');
    expect(activeNavKey('/acme/documents', 'acme')).toBe('documents');
    expect(activeNavKey('/acme/documents/PAN-PRD-1', 'acme')).toBe('documents');
    expect(activeNavKey('/acme/settings/notifications', 'acme')).toBe('notifications');
  });
});
