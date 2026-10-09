'use client';

import { type ClipboardEvent, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { docxToMarkdown, htmlToMarkdown, uploadDataImages } from '@/features/documents/import';
import { IMPORT_LIMITS, importSummary } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

type Source = 'paste' | 'markdown' | 'docx';
type Target = Pick<DocumentDetail, 'id' | 'version' | 'source'>;

function ImportForm({ org, doc, onDone, onCancel }: { org: string; doc: Target; onDone: () => void; onCancel: () => void }) {
  const [source, setSource] = useState<Source>('paste');
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const commit = useApiMutation(
    async () => {
      const md = await uploadDataImages(org, doc.id, markdown ?? '');
      return doc.source === 'external'
        ? api(`/orgs/${org}/documents/${doc.id}/convert`, { method: 'POST', body: { baseVersion: doc.version, markdown: md } })
        : api(`/orgs/${org}/documents/${doc.id}/content`, { method: 'PUT', body: { baseVersion: doc.version, markdown: md } });
    },
    { silentError: true, invalidate: [documentKeys(org)], success: doc.source === 'external' ? '已转为 Flower 文档' : '已导入', onSuccess: onDone },
  );

  const readFile = async (file: File, kind: 'markdown' | 'docx') => {
    setReadError(null);
    setMarkdown(null);
    if (file.size > (kind === 'markdown' ? IMPORT_LIMITS.markdownBytes : IMPORT_LIMITS.docxBytes)) {
      setReadError(kind === 'markdown' ? 'Markdown 文件不能超过 2 MB' : 'Word 文件不能超过 20 MB');
      return;
    }
    setReading(true);
    try {
      setMarkdown(kind === 'markdown' ? await file.text() : await docxToMarkdown(file));
    } catch {
      setReadError('文件无法解析，请确认是有效的 .md 或 .docx 文件');
    } finally {
      setReading(false);
    }
  };

  const onPaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    setReadError(null);
    setMarkdown(null);
    if (!html) {
      setMarkdown(text);
      return;
    }
    setReading(true);
    try {
      setMarkdown(await htmlToMarkdown(html));
    } catch {
      setReadError('粘贴的内容无法解析，请改用 Markdown 或 Word 文件导入');
    } finally {
      setReading(false);
    }
  };

  const summary = markdown === null ? null : importSummary(markdown);
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        value={source}
        onValueChange={(v) => {
          setSource(v as Source);
          setMarkdown(null);
          setReadError(null);
        }}
      >
        <TabsList>
          <TabsTrigger value="paste">粘贴</TabsTrigger>
          <TabsTrigger value="markdown">Markdown 文件</TabsTrigger>
          <TabsTrigger value="docx">Word 文件</TabsTrigger>
        </TabsList>
      </Tabs>
      {source === 'paste' && (
        <div
          role="textbox"
          aria-label="粘贴区域"
          tabIndex={0}
          contentEditable
          suppressContentEditableWarning
          onPaste={(e) => void onPaste(e)}
          className="min-h-28 rounded-md border p-3 text-[13px] text-muted-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          在这里粘贴（Ctrl / ⌘ + V）从企业微信、飞书等文档复制的内容，标题、列表、表格与图片会保留。
        </div>
      )}
      {source === 'markdown' && (
        <Input
          type="file"
          aria-label="选择 Markdown 文件"
          accept=".md,.markdown,text/markdown,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f, 'markdown');
          }}
        />
      )}
      {source === 'docx' && (
        <Input
          type="file"
          aria-label="选择 Word 文件"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f, 'docx');
          }}
        />
      )}
      {reading && <p className="text-[13px] text-muted-foreground">正在解析…</p>}
      {readError && (
        <p role="alert" className="text-[13px] text-destructive">
          {readError}
        </p>
      )}
      {summary && markdown !== null && (
        <section aria-label="导入预览" className="flex flex-col gap-2">
          <p className="text-[13px]">
            {summary.chars} 字符 · {summary.sections} 个小节 · {summary.images} 张图片将上传为附件
            {summary.remoteImages > 0 && ` · ${summary.remoteImages} 张外部图片保留原链接（不转存）`}
          </p>
          <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-[12px] whitespace-pre-wrap">{markdown.slice(0, 3000)}</pre>
        </section>
      )}
      {doc.source === 'native' && <p className="text-[13px] text-muted-foreground">导入会替换当前正文，旧内容保留在修订记录里。</p>}
      <FormError error={commit.error} />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button disabled={!markdown?.trim() || commit.isPending} onClick={() => commit.mutate(undefined)}>
          确认导入
        </Button>
      </DialogFooter>
    </div>
  );
}

/** 外部 PRD 转为 Flower 文档，或给 Flower 文档导入内容：粘贴、上传 Markdown、上传 Word。 */
export function ImportDialog({
  org,
  doc,
  open,
  onOpenChange,
  onImported,
}: {
  org: string;
  doc: Target;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doc.source === 'external' ? '转为 Flower 文档' : '导入内容'}</DialogTitle>
        </DialogHeader>
        {open && <ImportForm org={org} doc={doc} onDone={onImported} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
