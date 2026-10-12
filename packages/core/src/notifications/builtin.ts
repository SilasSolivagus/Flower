import type { BuiltinTemplateKey, TemplateFormat } from './constants';

/**
 * 预置模板的默认内容（设计 §9.2）。数据结构见 sources.ts：事件消息 eventMessageData、概览卡片 overviewCardData、
 * 新需求 newRequirementsData、变更摘要 digestData。字色 info 绿、warning 橙红、comment 灰，由数据层给出。
 */
export const BUILTIN_TEMPLATES: Record<BuiltinTemplateKey, { name: string; format: TemplateFormat; body: string }> = {
  event: {
    name: '默认 · 事件推送',
    format: 'markdown',
    body: [
      '<font color="{{event.tone}}">{{event.label}}</font><font color="comment"> · {{product.name}}</font>',
      '**[{{subject.key}} {{subject.title}}]({{subject.url}})**',
      '{{#changes}}',
      '> {{label}}　<font color="comment">{{old}}</font> → <font color="{{tone}}">{{new}}</font>',
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
        source: '{{source}}',
        main_title: { title: '{{title}}', desc: '{{desc}}' },
        emphasis_content: '{{emphasis}}',
        horizontal_content_list: '{{stats}}',
        quote_area: '{{quote}}',
        jump_list: '{{jumps}}',
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
      '# 📋 {{product.name}} 新增需求 · {{dateLabel}}',
      '> 新增 <font color="{{colors.newCount}}">{{newCount}}</font> 条 · 线上转需求 <font color="{{colors.onlineCount}}">{{onlineCount}}</font> 条 · P0/P1 <font color="{{colors.urgentCount}}">{{urgentCount}}</font> 条',
      '{{#sections}}',
      '',
      '**{{title}}**',
      '{{#items}}',
      '',
      '**{{index}}.** [{{key}} {{title}}]({{url}}) <font color="{{priorityColor}}">{{priority}}</font>',
      '<font color="comment">{{meta}}</font>{{#prdUrl}} · [PRD]({{prdUrl}}){{/prdUrl}}',
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
      '# {{product.name}} 变更摘要 · {{time}}',
      '> {{period}} · {{eventCount}} 项变化 · {{subjectCount}} 个对象',
      '{{#groups}}',
      '',
      '**[{{key}} {{title}}]({{url}})**',
      '{{#lines}}',
      '{{#changes}}',
      '> {{label}}　<font color="comment">{{old}}</font> → <font color="{{tone}}">{{new}}</font>　<font color="comment">{{actor}} {{time}}</font>',
      '{{/changes}}',
      '{{^changes}}',
      '> <font color="{{tone}}">{{label}}</font>　<font color="comment">{{actor}} {{time}}</font>',
      '{{/changes}}',
      '{{/lines}}',
      '{{/groups}}',
    ].join('\n'),
  },
};

/** 以前版本的默认内容：组织里的预置行仍是其中之一（未被修改）时，读取与补齐时换成当前默认内容。 */
export const PREVIOUS_BUILTIN_BODIES: Record<BuiltinTemplateKey, string[]> = {
  event: [
    [
      '**{{product.name}} · {{event.label}}**',
      '[{{subject.key}} {{subject.title}}]({{subject.url}})',
      '{{#changes}}',
      '> {{label}}：{{old}} → {{new}}',
      '{{/changes}}',
      '<font color="comment">{{event.actor}} · {{event.time}}</font>',
    ].join('\n'),
  ],
  overview_card: [
    JSON.stringify(
      {
        card_type: 'text_notice',
        main_title: { title: '{{title}}', desc: '{{desc}}' },
        jump_list: [{ type: 1, title: '{{button.title}}', url: '{{button.url}}' }],
        card_action: { type: 1, url: '{{button.url}}' },
      },
      null,
      2,
    ),
  ],
  new_requirements: [
    [
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
  ],
  digest: [
    [
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
  ],
};

/** 预置行的内容：仍是以前的默认内容时换成当前默认内容，修改过的保持不变。 */
export function currentBuiltinBody(key: BuiltinTemplateKey, body: string): string {
  return PREVIOUS_BUILTIN_BODIES[key].includes(body) ? BUILTIN_TEMPLATES[key].body : body;
}
