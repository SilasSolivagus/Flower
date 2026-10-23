import { describe, expect, it } from 'vitest';
import { SLUG_RE } from '../packages/core/src/tenancy/orgs.ts';
import { SLUG, parseSeedArgs, type SeedMode } from './ux-seed-batch2-flags.ts';

describe('ux-seed:batch2 参数', () => {
  it('SLUG 通过组织标识校验', () => {
    expect(SLUG).toBe('flower-uxseed');
    expect(SLUG_RE.test(SLUG)).toBe(true);
    expect(SLUG_RE.test('flower_uxseed')).toBe(false);
  });

  it.each<{ label: string; argv: string[]; mode: SeedMode }>([
    { label: '无参', argv: [], mode: 'seed' },
    { label: '只有运行路径', argv: ['node', '.local-data/ux-seed-batch2.mjs'], mode: 'seed' },
    { label: '--clean', argv: ['node', '.local-data/ux-seed-batch2.mjs', '--clean'], mode: 'reseed' },
    { label: '--clean-only', argv: ['node', '.local-data/ux-seed-batch2.mjs', '--clean-only'], mode: 'clean-only' },
  ])('$label → $mode', ({ argv, mode }) => {
    expect(parseSeedArgs(argv)).toEqual({ mode });
  });

  it.each<{ label: string; argv: string[] }>([
    { label: '先 --clean', argv: ['--clean', '--clean-only'] },
    { label: '先 --clean-only', argv: ['node', '.local-data/ux-seed-batch2.mjs', '--clean-only', '--clean'] },
  ])('$label 同时传入则抛错', ({ argv }) => {
    expect(() => parseSeedArgs(argv)).toThrow('不能同时使用 --clean 和 --clean-only');
  });
});
