import { describe, expect, it } from 'vitest';
import { releaseStatusText } from './labels';

describe('发布版本状态文案', () => {
  it('计划中', () => {
    expect(releaseStatusText({ status: 'planned', releasedAt: null })).toBe('计划中');
  });

  it('已发布且有发布时间：拼接格式化日期', () => {
    const iso = new Date(2026, 7, 20, 9, 0).toISOString();
    expect(releaseStatusText({ status: 'released', releasedAt: iso })).toBe('已发布 2026-08-20');
  });

  it('已发布但没有发布时间：只显示状态', () => {
    expect(releaseStatusText({ status: 'released', releasedAt: null })).toBe('已发布');
  });
});
