import { describe, expect, it } from 'vitest';
import { type BriefContext, briefContextMarkdown, briefToPrdMarkdown, evaluateBriefGate, type BriefGate } from '../src/documents/brief-model';
import { BRIEF_GATE_ITEMS, BRIEF_SECTIONS, BRIEF_TEMPLATE, BRIEF_TO_PRD } from '../src/documents/brief-template';
import type { BriefGateCheck } from '../src/documents/constants';
import { missingRequiredSections, splitSections } from '../src/documents/markdown';

const T = BRIEF_TEMPLATE.body;
const gate = (markdown: string, checks: BriefGateCheck[] = []): BriefGate =>
  evaluateBriefGate({ markdown, templateBody: T, checks, names: new Map([['m1', '决策人甲']]) });
const item = (g: BriefGate, no: number) => g.items.find((i) => i.no === no)!;

/** 把第 no 节的正文换成 text（保留标题行）。 */
function fill(md: string, no: number, text: string): string {
  const heading = BRIEF_SECTIONS[no - 1]!.heading;
  return splitSections(md)
    .map((s) => (s.heading === heading ? `${s.markdown.split('\n')[0]}\n\n${text}\n` : s.markdown))
    .join('\n');
}

/** 去掉第 no 节（连同标题）。 */
const drop = (md: string, no: number): string =>
  splitSections(md)
    .filter((s) => s.heading !== BRIEF_SECTIONS[no - 1]!.heading)
    .map((s) => s.markdown)
    .join('\n');

/** 模拟编辑器保存后的写法：表格补空格、分隔线变长、列表符号改为 *、方括号与标题编号加反斜杠。 */
const reformat = (md: string): string =>
  md
    .split('\n')
    .map((l) => (l.startsWith('|') ? l.replace(/\| --- /g, '| ------ ').replace(/ \| /g, '  |  ') : l.startsWith('- ') ? `* ${l.slice(2)}` : l))
    .join('\n')
    .replace(/\[数值\]/g, '\\[数值\\]')
    .replace(/^## (\d+)\. /gm, '## $1\\. ');

const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
const s8 = (rows: string[][]) =>
  ['| # | 要核对的现状 | 结论 | 证据（仓库 文件:行号 / 提交号） | 核对日期 | 和他人说法的差异 |', '| --- | --- | --- | --- | --- | --- |', ...rows.map(row)].join('\n');
const s16 = (flags: string[]) =>
  ['| # | 问题 | 选项 | 建议 | 待谁定 | 是否阻塞 PRD |', '| --- | --- | --- | --- | --- | --- |', ...flags.map((f, i) => row([String(i + 1), `问题${i + 1}`, '', '', '', f]))].join('\n');

describe('预置简报模板', () => {
  it('18 个必填小节与正文的二级标题一一对应；原样模板的每一节都算未填写；闸口 11 项，自动 1、7、10', () => {
    expect(BRIEF_TEMPLATE.sections).toHaveLength(18);
    expect(BRIEF_TEMPLATE.sections.every((s) => s.required)).toBe(true);
    expect(splitSections(T).filter((s) => s.level === 2).map((s) => s.heading)).toEqual(BRIEF_SECTIONS.map((s) => s.heading));
    expect(missingRequiredSections(T, BRIEF_TEMPLATE)).toEqual(BRIEF_SECTIONS.map((s) => s.heading));
    expect(BRIEF_GATE_ITEMS).toHaveLength(11);
    expect(BRIEF_GATE_ITEMS.filter((g) => g.auto).map((g) => g.no)).toEqual([1, 7, 10]);
    expect(BRIEF_TO_PRD.flatMap((c) => c.from).every((n) => n >= 1 && n <= 18)).toBe(true);
    expect(T).not.toMatch(/[`$]/);
    expect(BRIEF_TEMPLATE.guidance.split('\n')).toHaveLength(3);
  });
});

describe('闸口第 1 项：第 1–14 节没有空白', () => {
  it('原样模板与编辑器重排后的模板都算 14 节未填写；7、10 两项通过；人工项未勾选', () => {
    for (const md of [T, reformat(T)]) {
      const g = gate(md);
      expect(item(g, 1).passed).toBe(false);
      expect(item(g, 1).reasons).toHaveLength(14);
      expect(item(g, 1).reasons[0]).toBe('「1. 问题与目标」还没有填写');
      expect(item(g, 1).section).toBe('1. 问题与目标');
      expect(item(g, 7).passed).toBe(true);
      expect(item(g, 10).passed).toBe(true);
      expect([g.passed, g.total]).toEqual([2, 11]);
    }
  });

  it('逐节写了内容后通过；「不适用：理由」算填写；只写「不适用」或「不适用：」不算', () => {
    let md = T;
    for (let no = 1; no <= 14; no++) md = fill(md, no, `第 ${no} 节的结论`);
    expect(item(gate(md), 1)).toMatchObject({ passed: true, reasons: [], section: null });
    expect(item(gate(reformat(md)), 1).passed).toBe(true);
    expect(item(gate(fill(md, 5, '不适用：只有一种对象')), 1).passed).toBe(true);
    for (const text of ['不适用：', '不适用', '不适用： ']) {
      const g = gate(fill(md, 5, text));
      expect(item(g, 1).reasons, text).toEqual(['「5. 对象与状态」写了「不适用」但没有写理由']);
      expect(item(g, 1).section).toBe('5. 对象与状态');
    }
  });

  it('表格单元格里填了答案即算填写；缺小节时说明缺哪一节，不给定位', () => {
    const cell = T.replace('| 要解决什么问题（带数字） | |', '| 要解决什么问题（带数字） | 上传失败率 3% |');
    expect(item(gate(cell), 1).reasons).toHaveLength(13);
    expect(item(gate(cell), 1).reasons[0]).toBe('「2. 数据依据」还没有填写');
    let md = T;
    for (let no = 1; no <= 14; no++) md = fill(md, no, '已填写');
    expect(item(gate(drop(md, 9)), 1)).toMatchObject({ passed: false, reasons: ['缺少小节「9. 可行性与性能」'], section: null });
  });
});

describe('闸口第 7、10 项', () => {
  it('第 8 节：填了结论的行必须有证据与核对日期', () => {
    const ok = fill(T, 8, s8([['1', '上传限速', '有', 'web/upload.ts:42', '2026-10-10', ''], ['2', '下载限速', '', '', '', '']]));
    expect(item(gate(ok), 7).passed).toBe(true);
    const bad = fill(T, 8, s8([['1', '上传限速', '有', '', '2026-10-10', ''], ['2', '秒传', '无', '', ' ', '']]));
    expect(item(gate(bad), 7)).toMatchObject({ passed: false, reasons: ['第 1 行缺少「证据」', '第 2 行缺少「证据」「核对日期」'], section: '8. 现状核对' });
    expect(item(gate(reformat(bad)), 7).reasons).toHaveLength(2);
    expect(item(gate(drop(T, 8)), 7).reasons).toEqual(['缺少小节「8. 现状核对」']);
  });

  it('第 16 节：「是否阻塞 PRD」为「是」的问题不通过；模板默认的「是 / 否」不算', () => {
    expect(item(gate(fill(T, 16, s16(['否', '是 / 否']))), 10).passed).toBe(true);
    expect(item(gate(fill(T, 16, s16(['否', '是']))), 10)).toMatchObject({ passed: false, reasons: ['第 2 个待定问题标为阻塞 PRD'], section: '16. 待定问题' });
    expect(item(gate(drop(T, 16)), 10).reasons).toEqual(['缺少小节「16. 待定问题」']);
  });
});

describe('闸口人工项', () => {
  it('勾选记录带勾选人与时间；成员已删除时显示「已删除的成员」；勾选记录里的自动项编号被忽略', () => {
    const g = gate(T, [
      { item: 2, memberId: 'm1', at: '2026-10-14T02:00:00.000Z' },
      { item: 4, memberId: 'gone', at: '2026-10-14T03:00:00.000Z' },
      { item: 7, memberId: 'm1', at: '2026-10-14T04:00:00.000Z' },
    ]);
    expect(item(g, 2)).toMatchObject({ auto: false, passed: true, checkedBy: { id: 'm1', displayName: '决策人甲' }, checkedAt: '2026-10-14T02:00:00.000Z' });
    expect(item(g, 4).checkedBy).toEqual({ id: 'gone', displayName: '已删除的成员' });
    expect(item(g, 3)).toMatchObject({ passed: false, checkedBy: null, checkedAt: null });
    expect(item(g, 7)).toMatchObject({ auto: true, checkedBy: null });
    expect(g.passed).toBe(4);
  });
});

describe('转 PRD 的拼接', () => {
  it('按第 18 节的对应表生成章节；每章注明来源小节并原样放入内容；空节写明为空', () => {
    let md = fill(T, 1, '上传失败率 3%');
    md = fill(md, 16, s16(['否']));
    const prd = briefToPrdMarkdown({ briefKey: 'PAN-B-2', markdown: md });
    expect(prd.split('\n')[0]).toBe('> 由简报 [[PAN-B-2]] 生成。各章节下的引用块注明内容来自简报的哪一节，请按 PRD 的写法改写后再提交评审。');
    const sections = splitSections(prd);
    expect(sections.filter((s) => s.heading).map((s) => s.heading)).toEqual(BRIEF_TO_PRD.map((c) => c.heading));
    const of = (h: string) => sections.find((s) => s.heading === h)!.markdown;
    expect(of('1. 背景介绍')).toContain('> 来自简报第 1 节「问题与目标」\n\n上传失败率 3%');
    expect(of('1. 背景介绍')).toContain('> 来自简报第 2 节「数据依据」');
    expect(of('6.2 开放问题')).toContain('| 1 | 问题1 |');
    expect(of('7. 测试要点')).toContain('> 取第 4 节的边界情况、第 7 节的算例、第 10 节');
    expect(briefToPrdMarkdown({ briefKey: 'PAN-B-2', markdown: '' })).toContain('（简报中这一节为空）');
    expect(missingRequiredSections(prd, { body: '', sections: [{ heading: '1. 背景介绍', required: true }, { heading: '3. 需求说明', required: true }] })).toEqual([]);
  });
});

describe('上下文 Markdown', () => {
  it('头部表、覆盖的需求、闸口与正文；表格单元格里的竖线转义，空值写「—」', () => {
    const ctx: BriefContext = {
      brief: {
        id: 'b1',
        displayKey: 'PAN-B-2',
        title: '上传提速',
        status: 'discussing',
        statusLabel: '讨论中',
        product: { key: 'PAN', name: '网盘' },
        version: 'v0.2',
        requester: null,
        decider: '决策人甲',
        author: '作者乙',
        participants: ['产品', '后端'],
        relatedLinks: [
          { kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' },
          { kind: 'url', url: 'https://doc.example.com/a|b', note: '' },
        ],
        convertedDocument: null,
        updatedAt: '2026-10-14T02:00:00.000Z',
      },
      requirements: [{ displayKey: 'PAN-12', title: '上传 | 提速', state: '设计中' }],
      gate: gate(T),
      markdown: '## 1. 问题与目标\n\n正文\n',
    };
    const out = briefContextMarkdown(ctx);
    expect(out.startsWith('# PAN-B-2 上传提速\n')).toBe(true);
    expect(out).toContain('| 产品 | 网盘（PAN） |');
    expect(out).toContain('| 决策人 | 决策人甲 |');
    expect(out).toContain('| 提出人 | — |');
    expect(out).toContain('| 参与方 | 产品、后端 |');
    expect(out).toContain('| 关联文档 | [[PAN-PRD-1]] 旧方案；https://doc.example.com/a\\|b |');
    expect(out).toContain('| 转出的 PRD | — |');
    expect(out).toContain('| PAN-12 | 上传 \\| 提速 | 设计中 |');
    expect(out).toContain('## 写 PRD 闸口（2/11）');
    expect(out).toContain('- [ ] 1. 第 1~14 节没有空白，不涉及的都写了理由：「1. 问题与目标」还没有填写；');
    expect(out).toContain('- [x] 7. 第 8 节的每条现状都有代码证据和核对日期\n');
    expect(out).toContain('- [ ] 2. 第 1 节的问题有数字支撑（第 2 节）（人工确认）');
    expect(out.endsWith('## 正文\n\n### 1. 问题与目标\n\n正文\n')).toBe(true);
    const deep = briefContextMarkdown({ ...ctx, markdown: '# 总标题\n\n```\n## 代码里的\n```\n\n## 二级\n\n###### 六级\n' });
    expect(deep).toContain('## 正文\n\n### 总标题\n\n```\n## 代码里的\n```\n\n#### 二级\n\n###### 六级\n');
    expect(briefContextMarkdown({ ...ctx, requirements: [] })).toContain('## 覆盖的需求\n\n没有覆盖需求\n');
  });
});
