'use client';

import { PrdEditor, type PrdEditorProps } from './prd-editor';

/** PRD 正文编辑器的入口。是否对大文档按小节懒加载由 Task 1 的基线决定（见计划「设计决定」）。 */
export function DocumentBodyEditor(props: PrdEditorProps) {
  return <PrdEditor {...props} />;
}
