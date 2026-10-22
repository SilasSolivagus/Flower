export async function resolveReplaceConfirmation(input: {
  replace: boolean;
  orgSlug: string;
  confirmFlag?: string;
  isTTY: boolean;
  ask?: (prompt: string) => Promise<string>;
}): Promise<string | undefined> {
  if (!input.replace) return undefined;
  if (input.confirmFlag !== undefined) {
    if (input.confirmFlag !== input.orgSlug) {
      throw new Error(`确认失败：--confirm-replace 必须与组织 slug「${input.orgSlug}」完全一致`);
    }
    return input.orgSlug;
  }
  if (!input.isTTY) {
    throw new Error('非交互环境覆盖组织必须带 --confirm-replace <slug>，且与 --org-slug 完全一致');
  }
  if (!input.ask) {
    throw new Error('非交互环境覆盖组织必须带 --confirm-replace <slug>，且与 --org-slug 完全一致');
  }
  const answer = await input.ask(`将删除组织 ${input.orgSlug} 的全部数据，请输入组织 slug 确认：`);
  if (answer !== input.orgSlug) {
    throw new Error(`确认失败：输入的 slug 与组织 slug「${input.orgSlug}」不一致`);
  }
  return input.orgSlug;
}
