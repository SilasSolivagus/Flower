import { describe, expect, it } from 'vitest';
import {
  canTransition,
  detectProvider,
  diffRevisionSnapshots,
  diffSections,
  documentDisplayKey,
  fillTemplate,
  locateQuote,
  missingRequiredSections,
  normalizeExternalUrl,
  parseDocumentKey,
  plainText,
  prdCheckState,
  splitSections,
} from '../src/documents/markdown';

const DOC = [
  '开头说明',
  '',
  '## 1. 背景介绍',
  '',
  '### 1.1 业务背景',
  '',
  '用户反馈上传 **大文件** 太慢。',
  '',
  '```',
  '## 代码块里的标题',
  '```',
  '',
  '## 2. 需求说明',
  '',
  '| 序号 | 需求 |',
  '|---|---|',
  '| R1 | 分片上传 |',
  '',
  '## 2. 需求说明',
  '',
  '- 断点续传，见[接口文档](https://example.com/api)',
].join('\n');

describe('编号与状态', () => {
  it('显示格式与解析', () => {
    expect(documentDisplayKey('PAN', 12)).toBe('PAN-PRD-12');
    expect(parseDocumentKey(' PAN-PRD-12 ')).toEqual({ productKey: 'PAN', number: 12 });
    expect(parseDocumentKey('PAN-12')).toBeNull();
  });

  it('状态流转与「PRD」检查项映射', () => {
    expect(canTransition('draft', 'review')).toBe(true);
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('approved', 'launched')).toBe(true);
    expect(canTransition('launched', 'merged')).toBe(false);
    expect(canTransition('discarded', 'draft')).toBe(true);
    expect(['draft', 'review', 'approved', 'launched', 'merged', 'discarded'].map((s) => prdCheckState(s as never))).toEqual([
      'in_progress', 'in_progress', 'passed', 'passed', 'passed', 'not_needed',
    ]);
  });
});

describe('小节与对比', () => {
  it('按 1–3 级标题切分，代码块里的 # 不算；同名小节加序号', () => {
    const s = splitSections(DOC);
    expect(s.map((x) => x.key)).toEqual(['（开头）', '1. 背景介绍', '1. 背景介绍 / 1.1 业务背景', '2. 需求说明', '2. 需求说明#2']);
    expect(s[2]!.markdown).toContain('## 代码块里的标题');
    expect(s.map((x) => x.markdown).join('\n')).toBe(DOC);
  });

  it('按小节返回新增、删除、修改，修改的小节给出逐行差异；没变的小节不返回', () => {
    const next = DOC.replace('| R1 | 分片上传 |', '| R1 | 分片上传 |\n| R2 | 秒传 |').replace('开头说明\n\n', '') + '\n\n## 3. 埋点\n\n上报上传耗时';
    const changes = diffSections(DOC, next);
    expect(changes.map((c) => [c.key, c.change])).toEqual([
      ['2. 需求说明', 'modified'],
      ['3. 埋点', 'added'],
      ['（开头）', 'removed'],
    ]);
    expect(changes[0]!.lines.filter((l) => l.type !== 'same')).toEqual([{ type: 'add', text: '| R2 | 秒传 |' }]);
    expect(diffRevisionSnapshots({ title: '旧', markdown: DOC }, { title: '新', markdown: DOC })).toEqual({ title: { old: '旧', new: '新' }, sections: [] });
  });
});

describe('纯文本与文本引用定位', () => {
  it('纯文本去掉 Markdown 语法', () => {
    const t = plainText(DOC);
    expect(t).toContain('1. 背景介绍');
    expect(t).toContain('用户反馈上传 大文件 太慢。');
    expect(t).toContain('断点续传，见接口文档');
    expect(t).not.toContain('|---|');
    expect(t).not.toContain('https://example.com');
  });

  it('按引用与前后文定位到小节，忽略空白与强调符号；多处出现时按前后文取最匹配的一处', () => {
    expect(locateQuote(DOC, { quote: '上传大文件', prefix: '用户反馈', suffix: '太慢' })).toEqual({ sectionHeading: '1.1 业务背景' });
    expect(locateQuote(DOC, { quote: 'R1 分片上传', prefix: '序号需求', suffix: '' })).toEqual({ sectionHeading: '2. 需求说明' });
    expect(locateQuote(DOC, { quote: '需求说明', prefix: '分片上传', suffix: '断点续传' })).toEqual({ sectionHeading: '2. 需求说明' });
    expect(locateQuote(DOC, { quote: '已经删掉的句子', prefix: '', suffix: '' })).toBeNull();
    expect(locateQuote(DOC, { quote: '   ', prefix: '', suffix: '' })).toBeNull();
  });
});

describe('外部网址', () => {
  it('规范化：去追踪参数与分享码、片段、末尾斜杠，主机名小写，协议统一；原文保留', () => {
    expect(normalizeExternalUrl(' https://Doc.Weixin.QQ.com/doc/w3_AB/?scode=xyz&utm_source=x#h1 ')).toEqual({
      url: 'https://Doc.Weixin.QQ.com/doc/w3_AB/?scode=xyz&utm_source=x#h1',
      key: 'https://doc.weixin.qq.com/doc/w3_AB',
      provider: 'wecom',
    });
    expect(normalizeExternalUrl('http://docs.qq.com:443/sheet/X?tab=b&a=1')!.key).toBe('https://docs.qq.com/sheet/X?a=1&tab=b');
    expect(normalizeExternalUrl('https://www.figma.com/design/K/x?node-id=1-2&t=abc')!.key).toBe('https://www.figma.com/design/K/x?node-id=1-2');
    expect(normalizeExternalUrl('需求仅设计了流程图')).toBeNull();
    expect(normalizeExternalUrl('https://a.com/x y')).toBeNull();
  });

  it('按主机名识别平台', () => {
    expect(['doc.weixin.qq.com', 'docs.qq.com', 'abc.feishu.cn', 'x.larksuite.com', 'www.notion.so', 'team.notion.site', 'demo.yuque.com', 'docs.google.com', 'example.com'].map(detectProvider)).toEqual([
      'wecom', 'tencent_docs', 'feishu', 'feishu', 'notion', 'notion', 'yuque', 'google_docs', 'other',
    ]);
  });
});

describe('模板', () => {
  const template = {
    body: '## 1. 背景介绍\n\n### 1.1 业务背景\n\n简述本需求所处的业务背景。\n\n## 3. 需求说明\n\n| 序号 | 需求名称 |\n|---|---|\n| R1 | 待填 |\n',
    sections: [
      { heading: '1. 背景介绍', required: true },
      { heading: '2. 产品概述', required: false },
      { heading: '3. 需求说明', required: true },
    ],
  };

  it('占位符', () => {
    expect(fillTemplate('| {{date}} | {{author}} | 初稿 |', { date: '2026-10-08', author: '林澄' })).toBe('| 2026-10-08 | 林澄 | 初稿 |');
  });

  it('必填小节：标题不看编号与空白；只剩模板原文的小节算未填写', () => {
    expect(missingRequiredSections(template.body, template)).toEqual(['1. 背景介绍', '3. 需求说明']);
    const filled = template.body.replace('简述本需求所处的业务背景。', '上传慢的投诉占三成。').replace('| R1 | 待填 |', '| R1 | 分片上传 |');
    expect(missingRequiredSections(filled.replace('## 3. 需求说明', '## 三、需求说明'), template)).toEqual(['3. 需求说明']);
    expect(missingRequiredSections(filled, template)).toEqual([]);
  });
});
