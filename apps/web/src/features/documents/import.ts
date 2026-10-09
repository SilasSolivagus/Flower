import type { BlockNoteEditor } from '@blocknote/core';
import { apiUpload } from '@/lib/api';
import type { Attachment } from '@/lib/types';
import { base64ToBytes, findDataImages, replaceImageSources } from './model';

let converter: BlockNoteEditor | null = null;

/**
 * 不挂载的 BlockNote 实例，只用来做 HTML / Markdown 转换；粘贴、Word 导入与编辑器用同一套规则。
 * BlockNote 在用到时才加载，不进服务端渲染和页面首次加载。
 */
async function editor(): Promise<BlockNoteEditor> {
  if (!converter) {
    const { BlockNoteEditor } = await import('@blocknote/core');
    converter = BlockNoteEditor.create();
  }
  return converter;
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const e = await editor();
  return e.blocksToMarkdownLossy(e.tryParseHTMLToBlocks(html));
}

/** .docx → HTML（mammoth，图片内嵌为 data:）→ Markdown。mammoth 只在用到时加载。 */
export async function docxToMarkdown(file: Blob): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return htmlToMarkdown(value);
}

/**
 * 把正文里的 data: 图片逐个上传为这份 PRD 的附件并替换成附件网址。cache 记录已上传过的图片，
 * 编辑器自动保存时传同一个 cache，同一张图不会重复上传。
 */
export async function uploadDataImages(org: string, documentId: string, markdown: string, cache: Map<string, string> = new Map()): Promise<string> {
  for (const [i, img] of findDataImages(markdown).entries()) {
    if (cache.has(img.src)) continue;
    const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime.slice('image/'.length);
    const blob = new Blob([base64ToBytes(img.base64)], { type: img.mime });
    const res = await apiUpload<{ attachment: Attachment }>(`/orgs/${org}/documents/${documentId}/attachments`, blob, `image-${i + 1}.${ext}`);
    cache.set(img.src, res.attachment.url);
  }
  return replaceImageSources(markdown, cache);
}
