const PARA = '本节说明该功能在不同场景下的处理方式，包括入口位置、默认值、异常提示与埋点要求，全部文字均为测试用的虚构内容。';

/**
 * 合成一篇约 targetChars 字符的 PRD：结构按最大旧 PRD 的比例（约每 270 字一个小标题，表格行约占三分之一），
 * 只用虚构文字，可以提交。
 */
export function syntheticPrd(targetChars: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let n = 1; size < targetChars; n++) {
    const chunk = [
      `## ${n}. 功能模块 ${n}`,
      '',
      `### ${n}.1 规则说明`,
      '',
      PARA,
      '',
      `- 规则 ${n}-1：${PARA.slice(0, 30)}`,
      `- 规则 ${n}-2：${PARA.slice(10, 40)}`,
      '',
      '| 字段 | 说明 | 默认值 |',
      '|---|---|---|',
      ...Array.from({ length: 4 }, (_, i) => `| 字段${n}-${i + 1} | ${PARA.slice(0, 24)} | 无 |`),
      '',
    ].join('\n');
    parts.push(chunk);
    size += chunk.length + 1;
  }
  return parts.join('\n');
}
