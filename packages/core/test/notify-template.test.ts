import { describe, expect, it } from 'vitest';
import { assertTemplateBody, payloadPreview, renderMessage, renderTemplate, splitMarkdown, toChannelPayloads, truncateBytes } from '../src/notifications/template';

describe('模板渲染', () => {
  it('字段替换：点号路径；缺字段、null、对象渲染为空串；数字与布尔转文字', () => {
    expect(renderTemplate('{{a.b}}-{{missing}}-{{n}}-{{flag}}-{{obj}}-{{nil}}', { a: { b: '值' }, n: 3, flag: true, obj: { x: 1 }, nil: null })).toBe('值--3-true--');
  });

  it('列表重复：项内先查项再查外层；非空值渲染一次；反向区块在值为空时渲染', () => {
    const tpl = '{{#items}}[{{name}}@{{group}}]{{/items}}{{#note}}<{{note}}>{{/note}}{{^items}}无{{/items}}';
    expect(renderTemplate(tpl, { group: 'G', items: [{ name: 'a' }, { name: 'b', group: 'H' }], note: '备注' })).toBe('[a@G][b@H]<备注>');
    expect(renderTemplate(tpl, { items: [] })).toBe('无');
  });

  it('独占一行的区块标签连同换行去掉', () => {
    const tpl = '标题\n{{#items}}\n- {{.}}{{name}}\n{{/items}}\n结尾';
    expect(renderTemplate(tpl, { items: [{ name: '一' }, { name: '二' }] })).toBe('标题\n- 一\n- 二\n结尾');
  });

  it('语法错误：区块没有结束、结束标签不配对；卡片必须是 JSON 对象', () => {
    expect(() => assertTemplateBody('markdown', '{{#a}}x')).toThrow('模板语法错误');
    expect(() => assertTemplateBody('markdown', '{{#a}}x{{/b}}')).toThrow('模板语法错误');
    expect(() => assertTemplateBody('template_card', '[1]')).toThrow('模板卡片的内容应为 JSON 对象');
    expect(() => assertTemplateBody('template_card', '{"main_title":{"title":"{{#x}}"}}')).toThrow('模板语法错误');
    expect(() => assertTemplateBody('text', '你好 {{name}}')).not.toThrow();
  });

  it('卡片：只替换字符串值；文本类去掉首尾空白', () => {
    const card = renderMessage('template_card', '{"card_type":"text_notice","main_title":{"title":"{{t}}"},"jump_list":[{"type":1,"url":"{{u}}"}]}', { t: '日报', u: 'http://127.0.0.1/x' });
    expect(card).toEqual({ format: 'template_card', card: { card_type: 'text_notice', main_title: { title: '日报' }, jump_list: [{ type: 1, url: 'http://127.0.0.1/x' }] } });
    expect(renderMessage('markdown', '\n**{{t}}**\n\n', { t: '标题' })).toEqual({ format: 'markdown', text: '**标题**' });
  });
});

describe('按通道生成请求体', () => {
  const md = { format: 'markdown' as const, text: '# 标题\n正文' };
  const card = { format: 'template_card' as const, card: { card_type: 'text_notice', main_title: { title: '日报 · 2026-10-09', desc: '1016 发版' }, jump_list: [{ type: 1, title: '查看', url: 'http://127.0.0.1/i/1' }] } };

  it('企微：文本、markdown、模板卡片、邮件格式转文本', () => {
    expect(toChannelPayloads('wecom_robot', md)).toEqual([{ type: 'json', body: { msgtype: 'markdown', markdown: { content: '# 标题\n正文' } } }]);
    expect(toChannelPayloads('wecom_robot', { format: 'text', text: '你好' })).toEqual([{ type: 'json', body: { msgtype: 'text', text: { content: '你好' } } }]);
    expect(toChannelPayloads('wecom_robot', card)).toEqual([{ type: 'json', body: { msgtype: 'template_card', template_card: card.card } }]);
    expect(toChannelPayloads('wecom_robot', { format: 'email', text: '主题\n正文' })).toEqual([{ type: 'json', body: { msgtype: 'text', text: { content: '主题\n正文' } } }]);
  });

  it('Webhook：{format, content}；卡片的 content 为对象', () => {
    expect(toChannelPayloads('webhook', md)).toEqual([{ type: 'json', body: { format: 'markdown', content: '# 标题\n正文' } }]);
    expect(toChannelPayloads('webhook', card)).toEqual([{ type: 'json', body: { format: 'template_card', content: card.card } }]);
  });

  it('邮件：主题取第一行并去掉 markdown 标记；email 格式第一行是主题；卡片取标题、描述与链接', () => {
    expect(toChannelPayloads('email', { format: 'markdown', text: '**PAN-1 新建需求**\n> 详情' })).toEqual([{ type: 'email', subject: 'PAN-1 新建需求', text: '**PAN-1 新建需求**\n> 详情' }]);
    expect(toChannelPayloads('email', { format: 'email', text: '周报\n第一行\n第二行' })).toEqual([{ type: 'email', subject: '周报', text: '第一行\n第二行' }]);
    expect(toChannelPayloads('email', card)).toEqual([{ type: 'email', subject: '日报 · 2026-10-09', text: '1016 发版\n查看：http://127.0.0.1/i/1' }]);
  });

  it('markdown 超过 4096 字节按段拆分，第 2 条起标题加「（续n）」；单段过长截断', () => {
    const para = (i: number) => `**${i}. ${'需求标题'.repeat(30)}**`;
    const text = ['# 📋 10/9 新增需求', ...Array.from({ length: 20 }, (_, i) => para(i + 1))].join('\n\n');
    const parts = splitMarkdown(text, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(4096);
    expect(parts[0]!.startsWith('# 📋 10/9 新增需求\n\n**1.')).toBe(true);
    expect(parts[1]!.startsWith('# 📋 10/9 新增需求（续2）\n\n')).toBe(true);
    expect(parts.join('\n')).toContain('**20.');
    expect(splitMarkdown('短文本')).toEqual(['短文本']);
    const long = truncateBytes('字'.repeat(3000), 2048);
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(2048);
    expect(long.endsWith('…')).toBe(true);
  });

  it('内容摘要：各类请求体取主要文字，最多 200 字', () => {
    expect(payloadPreview(null)).toBe('（发送前渲染）');
    expect(payloadPreview({ type: 'json', body: { msgtype: 'markdown', markdown: { content: '# 标题' } } })).toBe('# 标题');
    expect(payloadPreview({ type: 'json', body: { msgtype: 'template_card', template_card: card.card } })).toBe('日报 · 2026-10-09 · 1016 发版');
    expect(payloadPreview({ type: 'json', body: { format: 'text', content: '你好' } })).toBe('你好');
    expect(payloadPreview({ type: 'email', subject: '周报', text: '正文' })).toBe('周报');
    expect(payloadPreview({ type: 'legacy', content: 'x'.repeat(300) })).toHaveLength(200);
  });
});
