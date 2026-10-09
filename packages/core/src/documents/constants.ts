/** 变更 PRD 的状态。merged 只由合入自动进入（全部影响声明处理完）。 */
export const CHANGE_DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded'] as const;
export type ChangeDocumentStatus = (typeof CHANGE_DOCUMENT_STATUSES)[number];
/** 模块文档的状态：使用中 / 已归档（只读）。 */
export const MODULE_DOCUMENT_STATUSES = ['active', 'archived'] as const;
/** documents.status 的全部取值：两类文档共用一列。 */
export const DOCUMENT_STATUSES = [...CHANGE_DOCUMENT_STATUSES, ...MODULE_DOCUMENT_STATUSES] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_KINDS = ['change', 'module'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

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
