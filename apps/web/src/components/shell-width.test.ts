import { describe, expect, it } from 'vitest';
import { shellMainClassName } from './shell-width';

const LAYOUT = ['flex', 'w-full', 'flex-1', 'flex-col', 'gap-5', 'px-4', 'py-6', 'md:px-8'] as const;

/** 宽表页：没有 max-w，也不用 mx-auto 把主区卡在中间。 */
function expectWide(pathname: string) {
  const cls = shellMainClassName(pathname);
  expect(cls, pathname).not.toMatch(/max-w-/);
  expect(cls, pathname).not.toContain('mx-auto');
  for (const token of LAYOUT) expect(cls.split(/\s+/), pathname).toContain(token);
}

/** 阅读页：仍是 1280 居中，内边距与宽表页相同。 */
function expectReading(pathname: string) {
  const cls = shellMainClassName(pathname);
  expect(cls.split(/\s+/), pathname).toEqual([
    'mx-auto',
    'flex',
    'w-full',
    'max-w-[1280px]',
    'flex-1',
    'flex-col',
    'gap-5',
    'px-4',
    'py-6',
    'md:px-8',
  ]);
}

describe('shellMainClassName', () => {
  it('工作台、需求、迭代（含甘特所在详情）以及同壳宽表不加宽度上限', () => {
    for (const path of [
      '/acme',
      '/acme/requirements',
      '/acme/requirements/PAN-1',
      '/acme/iterations',
      '/acme/iterations/11111111-1111-1111-1111-111111111111',
      '/acme/tasks',
      '/acme/tasks/T-1',
      '/acme/work-items',
      '/acme/work-items/W-1',
      '/acme/workload',
      '/acme/tracking',
    ]) {
      expectWide(path);
    }
  });

  it('文档列表、正文和合并页保留 1280 居中', () => {
    expectReading('/acme/documents');
    expectReading('/acme/documents/DOC-1');
    expectReading('/acme/documents/DOC-1/merge');
  });

  it('未单列的组织内路由默认放宽，尾斜杠与 slug 不影响分段', () => {
    for (const path of [
      '/acme/overview',
      '/acme/dashboard',
      '/acme/reviews',
      '/acme/notifications',
      '/acme/settings',
      '/acme/settings/members',
      '/acme/settings/tracking',
      '/acme/requirements/',
    ]) {
      expectWide(path);
    }
    expectWide('/documents');
    expectReading('/documents/documents');
    expectReading('/documents/documents/');
  });
});
