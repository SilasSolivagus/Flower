import type { BuiltinTemplateKey, TemplateFormat } from './constants';

/**
 * 预置模板的默认内容。数据结构见 sources.ts：事件消息 eventMessageData、概览卡片 overviewCardData、
 * 新需求 newRequirementsData、变更摘要 digestData。新需求与概览卡片的版式按 push 的实际输出核对（见 P3-A 计划「设计决定」）。
 */
export const BUILTIN_TEMPLATES: Record<BuiltinTemplateKey, { name: string; format: TemplateFormat; body: string }> = {
  event: {
    name: '默认 · 事件推送',
    format: 'markdown',
    body: [
      '**{{product.name}} · {{event.label}}**',
      '[{{subject.key}} {{subject.title}}]({{subject.url}})',
      '{{#changes}}',
      '> {{label}}：{{old}} → {{new}}',
      '{{/changes}}',
      '<font color="comment">{{event.actor}} · {{event.time}}</font>',
    ].join('\n'),
  },
  overview_card: {
    name: '默认 · 概览卡片',
    format: 'template_card',
    body: JSON.stringify(
      {
        card_type: 'text_notice',
        main_title: { title: '{{title}}', desc: '{{desc}}' },
        jump_list: [{ type: 1, title: '{{button.title}}', url: '{{button.url}}' }],
        card_action: { type: 1, url: '{{button.url}}' },
      },
      null,
      2,
    ),
  },
  new_requirements: {
    name: '默认 · 新需求',
    format: 'markdown',
    body: [
      '# 📋 {{date}} 新增需求',
      '> 🆕 新增 {{newCount}} 条 · 🔧 线上转需求 {{onlineCount}} 条',
      '{{#sections}}',
      '',
      '**{{title}}**',
      '{{#items}}',
      '',
      '**{{index}}. [{{key}} {{title}}]({{url}})** <font color="{{priorityColor}}">{{priority}}</font>',
      '<font color="comment">{{meta}}</font>',
      '{{#brief}}',
      '<font color="comment">{{brief}}</font>',
      '{{/brief}}',
      '{{#prdUrl}}',
      '[PRD ↗]({{prdUrl}})',
      '{{/prdUrl}}',
      '{{/items}}',
      '{{/sections}}',
      '',
      '> 👉 [到 Flower 认领 / 分配 ↗]({{listUrl}})',
    ].join('\n'),
  },
  digest: {
    name: '默认 · 变更摘要',
    format: 'markdown',
    body: [
      '# 📋 {{product.name}} 变更摘要',
      '> {{period}} · 共 {{eventCount}} 项变化，涉及 {{subjectCount}} 个对象',
      '{{#groups}}',
      '',
      '**[{{key}} {{title}}]({{url}})**',
      '{{#lines}}',
      '> {{text}}',
      '{{/lines}}',
      '{{/groups}}',
    ].join('\n'),
  },
};
