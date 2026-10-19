/** 变更 PRD 的状态。merged 只由合入自动进入（全部影响声明处理完）。 */
export const CHANGE_DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded'] as const;
export type ChangeDocumentStatus = (typeof CHANGE_DOCUMENT_STATUSES)[number];
/** 模块文档的状态：使用中 / 已归档（只读）。 */
export const MODULE_DOCUMENT_STATUSES = ['active', 'archived'] as const;
/** 需求简报的状态（P3-C2）：讨论中 / 可写 PRD / 已转 PRD / 已废弃。converted 只由「转 PRD」进入。 */
export const BRIEF_STATUSES = ['discussing', 'ready', 'converted', 'discarded'] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];
/** documents.status 的全部取值：三类文档共用一列，discarded 为变更 PRD 与简报共用。 */
export const DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded', 'active', 'archived', 'discussing', 'ready', 'converted'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_KINDS = ['change', 'module', 'brief'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
/** 有模板的文档类型：变更 PRD 与简报（模块文档没有模板）。 */
export const TEMPLATE_KINDS = ['change', 'brief'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** 影响声明的变更类型与合入状态。 */
export const AFFECTED_CHANGE_TYPES = ['added', 'modified', 'removed'] as const;
export type AffectedChangeType = (typeof AFFECTED_CHANGE_TYPES)[number];
export const MERGE_STATUSES = ['pending', 'applied', 'skipped'] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

export const EXTERNAL_PROVIDERS = ['wecom', 'feishu', 'tencent_docs', 'notion', 'yuque', 'google_docs', 'other'] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export type TemplateSection = { heading: string; required: boolean; guidance?: string };
export type RevisionSnapshot = { title: string; markdown: string };
/** W3C TextQuoteSelector：引用的原文片段与前后文，加上所在小节标题。 */
export type TextAnchor = { quote: string; prefix: string; suffix: string; sectionHeading: string | null };

/** 简报头部「关联文档」的一条：[[ ]] 引用（存方括号里的写法）或外部网址，各带一句说明。 */
export type BriefRelatedLink = { kind: 'wiki'; target: string; note: string } | { kind: 'url'; url: string; note: string };
/** 简报闸口人工项的勾选记录：项号、勾选人、时间（ISO 字符串）。 */
export type BriefGateCheck = { item: number; memberId: string; at: string };
