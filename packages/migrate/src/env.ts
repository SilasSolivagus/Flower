const FLAG_WARNING = '连接串会进入命令历史，生产禁止使用，请改用 LEGACY_PRD_URL';

export function resolvePrdUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = (message) => console.error(message),
): { url: string; viaFlag: boolean } {
  const fromEnv = env.LEGACY_PRD_URL;
  if (fromEnv) {
    if (flag) warn(FLAG_WARNING);
    return { url: fromEnv, viaFlag: false };
  }
  if (flag) {
    warn(FLAG_WARNING);
    return { url: flag, viaFlag: true };
  }
  throw new Error('缺少旧 prd 库连接串：请设置环境变量 LEGACY_PRD_URL');
}
