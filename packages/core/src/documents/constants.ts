/** 变更 PRD 的状态。merged 属于 P2-B（合入），P2-A 不会进入这个状态。 */
export const DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const EXTERNAL_PROVIDERS = ['wecom', 'feishu', 'tencent_docs', 'notion', 'yuque', 'google_docs', 'other'] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export type TemplateSection = { heading: string; required: boolean; guidance?: string };
export type RevisionSnapshot = { title: string; markdown: string };
/** W3C TextQuoteSelector：引用的原文片段与前后文，加上所在小节标题。 */
export type TextAnchor = { quote: string; prefix: string; suffix: string; sectionHeading: string | null };
