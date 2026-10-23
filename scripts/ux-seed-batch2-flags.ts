/** 验收组织 slug。compose 项目名可以仍带下划线，不要写进这里。 */
export const SLUG = 'flower-uxseed';

export type SeedMode = 'seed' | 'reseed' | 'clean-only';

/** 无参播种；`--clean` 清完再种；`--clean-only` 只清不种。两个清理开关同时出现则抛错。 */
export function parseSeedArgs(argv: readonly string[]): { mode: SeedMode } {
  const clean = argv.includes('--clean');
  const cleanOnly = argv.includes('--clean-only');
  if (clean && cleanOnly) throw new Error('不能同时使用 --clean 和 --clean-only');
  if (cleanOnly) return { mode: 'clean-only' };
  if (clean) return { mode: 'reseed' };
  return { mode: 'seed' };
}
