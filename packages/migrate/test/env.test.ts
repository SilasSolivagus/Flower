import { describe, expect, it } from 'vitest';
import { resolvePrdUrl } from '../src/env';

describe('resolvePrdUrl', () => {
  it('只有环境变量时使用它，没有警告', () => {
    const warnings: string[] = [];
    expect(resolvePrdUrl(undefined, { LEGACY_PRD_URL: 'postgres://prd-src:5432/prd_src' }, (message) => warnings.push(message))).toEqual({
      url: 'postgres://prd-src:5432/prd_src',
      viaFlag: false,
    });
    expect(warnings).toEqual([]);
  });

  it('只有参数时使用参数，并警告', () => {
    const warnings: string[] = [];
    expect(resolvePrdUrl('postgres://example/from-flag', {}, (message) => warnings.push(message))).toEqual({
      url: 'postgres://example/from-flag',
      viaFlag: true,
    });
    expect(warnings).toEqual(['连接串会进入命令历史，生产禁止使用，请改用 LEGACY_PRD_URL']);
  });

  it('两个都有时以环境变量为准，并警告', () => {
    const warnings: string[] = [];
    expect(
      resolvePrdUrl('postgres://example/from-flag', { LEGACY_PRD_URL: 'postgres://prd-src:5432/prd_src' }, (message) => warnings.push(message)),
    ).toEqual({ url: 'postgres://prd-src:5432/prd_src', viaFlag: false });
    expect(warnings[0]).toContain('LEGACY_PRD_URL');
  });

  it('两个都没有时报错', () => {
    expect(() => resolvePrdUrl(undefined, {})).toThrow('LEGACY_PRD_URL');
  });
});
