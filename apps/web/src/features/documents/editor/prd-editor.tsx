'use client';

import '@blocknote/shadcn/style.css';
import { BlockNoteEditor } from '@blocknote/core';
import { zh } from '@blocknote/core/locales';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useTheme } from 'next-themes';
import { type Ref, useImperativeHandle, useState } from 'react';

export type PrdEditorHandle = { getMarkdown: () => string };
export type PrdEditorProps = {
  initialMarkdown: string;
  editable: boolean;
  onDirty?: () => void;
  uploadImage?: (file: File) => Promise<string>;
  ref?: Ref<PrdEditorHandle>;
};

/** Markdown → 块：用一个不挂载的编辑器实例解析，只在首次渲染时调用。空正文返回 undefined（BlockNote 要求初始内容非空）。 */
function parseMarkdown(markdown: string) {
  if (!markdown.trim()) return undefined;
  const blocks = BlockNoteEditor.create().tryParseMarkdownToBlocks(markdown);
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * 一篇 PRD 正文的 BlockNote 编辑器。Markdown 是唯一数据源：挂载时解析一次，之后由父组件
 * 通过 ref 的 getMarkdown() 在需要保存时序列化；正文被外部替换（冲突后重新加载、恢复版本）时由父组件换 key 重新挂载。
 */
export function PrdEditor({ initialMarkdown, editable, onDirty, uploadImage, ref }: PrdEditorProps) {
  const [initialContent] = useState(() => parseMarkdown(initialMarkdown));
  const editor = useCreateBlockNote({ initialContent, dictionary: zh, uploadFile: uploadImage });
  useImperativeHandle(ref, () => ({ getMarkdown: () => editor.blocksToMarkdownLossy(editor.document) }), [editor]);
  const { resolvedTheme } = useTheme();
  return <BlockNoteView editor={editor} editable={editable} onChange={() => onDirty?.()} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />;
}
