import { describe, expect, it } from 'vitest';
import {
  applyFeatureSection,
  featureSectionBody,
  featureSections,
  hasTopHeadings,
  prdSectionKeys,
  renameFeatureHeading,
  sourceSectionText,
} from '../src/documents/module-sections';

const DOC = '概述文字\n\n## 上传\n\n上传说明\n\n## 下载\n\n下载说明\n';

describe('模块文档按功能点分节', () => {
  it('只按二级标题切分；三级标题属于所在小节；代码块里的 # 不算', () => {
    const lines = '概述\n\n## 上传\n\n### 细节\n\n```\n## 不是标题\n```\n\n## 下载\n\n下载说明'.split('\n');
    expect(featureSections(lines).map((s) => [s.heading, s.start, s.end])).toEqual([
      ['上传', 2, 10],
      ['下载', 10, 13],
    ]);
  });

  it('小节正文：按归一化名称（去编号与空白）找第一个；不含标题行，去掉首尾空行；找不到为 null', () => {
    expect(featureSectionBody(DOC, '上传')).toBe('上传说明');
    expect(featureSectionBody('## 2. 上 传\n\n  缩进保留\n', '上传')).toBe('  缩进保留');
    expect(featureSectionBody('## 上传\n', '上传')).toBe('');
    expect(featureSectionBody(DOC, '分享')).toBeNull();
  });

  it('替换：保留原标题行，正文换成新内容；新内容为空时只留标题', () => {
    expect(applyFeatureSection(DOC, { name: '上传', body: '新的上传\n\n### 细节\n\n内容', order: [] })).toBe(
      '概述文字\n\n## 上传\n\n新的上传\n\n### 细节\n\n内容\n\n## 下载\n\n下载说明\n',
    );
    expect(applyFeatureSection('## 1. 上传\n\n旧\n', { name: '上传', body: '新', order: [] })).toBe('## 1. 上传\n\n新\n');
    expect(applyFeatureSection(DOC, { name: '下载', body: '  ', order: [] })).toBe('概述文字\n\n## 上传\n\n上传说明\n\n## 下载\n');
  });

  it('新增：按结构树顺序插到后面第一个已有小节之前；后面都没有时追加到文末；空文档直接写成该小节', () => {
    expect(applyFeatureSection(DOC, { name: '分享', body: '分享说明', order: ['上传', '分享', '下载'] })).toBe(
      '概述文字\n\n## 上传\n\n上传说明\n\n## 分享\n\n分享说明\n\n## 下载\n\n下载说明\n',
    );
    expect(applyFeatureSection(DOC, { name: '首页', body: '首页说明', order: ['首页', '上传', '下载'] })).toBe(
      '概述文字\n\n## 首页\n\n首页说明\n\n## 上传\n\n上传说明\n\n## 下载\n\n下载说明\n',
    );
    expect(applyFeatureSection(DOC, { name: '回收站', body: '回收站说明', order: ['上传', '下载', '回收站'] })).toBe(
      '概述文字\n\n## 上传\n\n上传说明\n\n## 下载\n\n下载说明\n\n## 回收站\n\n回收站说明\n',
    );
    expect(applyFeatureSection('概述', { name: '上传', body: '说明', order: ['上传'] })).toBe('概述\n\n## 上传\n\n说明\n');
    expect(applyFeatureSection('', { name: '上传', body: '说明', order: ['上传'] })).toBe('## 上传\n\n说明\n');
    expect(applyFeatureSection(DOC, { name: '不在树里', body: 'x', order: ['上传', '下载'] })).toBe(`${DOC}\n## 不在树里\n\nx\n`);
  });

  it('删除：移除整个小节（含下级标题）；找不到时原样返回', () => {
    expect(applyFeatureSection(DOC, { name: '上传', body: '', order: [], remove: true })).toBe('概述文字\n\n## 下载\n\n下载说明\n');
    expect(applyFeatureSection(DOC, { name: '下载', body: '', order: [], remove: true })).toBe('概述文字\n\n## 上传\n\n上传说明\n');
    expect(applyFeatureSection(DOC, { name: '分享', body: '', order: [], remove: true })).toBe(DOC);
  });

  it('功能点改名：只改标题行，保留编号；找不到返回 null', () => {
    expect(renameFeatureHeading(DOC, '上传', '极速上传')).toBe('概述文字\n\n## 极速上传\n\n上传说明\n\n## 下载\n\n下载说明\n');
    expect(renameFeatureHeading('## 2. 上传\n\n说明', '上传', '极速上传')).toBe('## 2. 极速上传\n\n说明');
    expect(renameFeatureHeading(DOC, '分享', '共享')).toBeNull();
  });

  it('合入内容不能有一级、二级标题（代码块内除外）', () => {
    expect(hasTopHeadings('### 细节\n\n正文')).toBe(false);
    expect(hasTopHeadings('```\n## 代码\n```')).toBe(false);
    expect(hasTopHeadings('正文\n## 新小节')).toBe(true);
    expect(hasTopHeadings('# 大标题')).toBe(true);
  });
});

const PRD = '# 概述\n\n总述\n\n## 需求说明\n\n要点\n\n### 上传\n\n上传细节\n\n### 下载\n\n下载细节\n\n## 其他\n\n别的';

describe('来源小节', () => {
  it('可选的小节：splitSections 的键，只含有标题的小节', () => {
    expect(prdSectionKeys(`开头\n\n${PRD}`)).toEqual(['概述', '概述 / 需求说明', '概述 / 需求说明 / 上传', '概述 / 需求说明 / 下载', '概述 / 其他']);
  });

  it('来源内容：小节正文加全部下级小节，标题级别下移到三级起；代码块内不改；找不到为 null', () => {
    expect(sourceSectionText(PRD, '概述 / 需求说明')).toBe('要点\n\n### 上传\n\n上传细节\n\n### 下载\n\n下载细节');
    expect(sourceSectionText(PRD, '概述')).toBe('总述\n\n### 需求说明\n\n要点\n\n#### 上传\n\n上传细节\n\n#### 下载\n\n下载细节\n\n### 其他\n\n别的');
    expect(sourceSectionText(PRD, '概述 / 需求说明 / 上传')).toBe('上传细节');
    expect(sourceSectionText('# 背景\n\n```\n# 代码\n```', '背景')).toBe('```\n# 代码\n```');
    expect(sourceSectionText(PRD, '概述 / 不存在')).toBeNull();
  });
});
