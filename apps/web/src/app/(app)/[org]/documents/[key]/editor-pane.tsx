'use client';

import dynamic from 'next/dynamic';
import { useQueryClient } from '@tanstack/react-query';
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { PrdEditorHandle } from '@/features/documents/editor/prd-editor';
import { type SelectionAnchor, selectionAnchor } from '@/features/documents/editor/selection';
import { uploadDataImages } from '@/features/documents/import';
import { type SaveState, saveStateLabel } from '@/features/documents/model';
import { ApiError, api, apiUpload } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Attachment, DocumentDetail } from '@/lib/types';
import { AnchorCommentDialog } from './comments';

type SaveResult = { version: number; revisionNumber: number };

// BlockNote 只在浏览器里运行
const DocumentBodyEditor = dynamic(() => import('@/features/documents/editor/body-editor').then((m) => m.DocumentBodyEditor), {
  ssr: false,
  loading: () => <Skeleton className="h-96" />,
});

export const AUTOSAVE_MS = 1000;

export type EditorPaneHandle = {
  /** 本页改标题成功后调用：服务端为原生 PRD 改标题会把版本号加一，紧接在当前版本之后时沿用，否则留给下次保存报冲突。 */
  onRenamed: (version: number) => void;
};

/**
 * Flower 内 PRD 的正文：编辑后 1 秒自动保存（带 baseVersion 乐观锁）。409 时停止自动保存、提示重新加载；
 * 重新加载由页面换 key 让本组件重新挂载，编辑器读取新的正文与版本号。
 */
export function EditorPane({ org, doc, onReload, ref }: { org: string; doc: DocumentDetail; onReload: () => void; ref?: Ref<EditorPaneHandle> }) {
  const editable = doc.myRole !== 'viewer';
  const handle = useRef<PrdEditorHandle>(null);
  const version = useRef(doc.version);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const blocked = useRef(false);
  // 粘贴进来的内嵌图片已转存的附件网址（data: → 附件网址），同一张图只上传一次
  const uploaded = useRef(new Map<string, string>());
  // 在途的保存请求：卸载时补发的保存要等它返回、用它的新版本号
  const lastSave = useRef<Promise<SaveResult> | null>(null);
  const [state, setState] = useState<SaveState>('saved');
  const qc = useQueryClient();
  const container = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<(SelectionAnchor & { top: number; left: number }) | null>(null);
  const [commenting, setCommenting] = useState<SelectionAnchor | null>(null);
  /** 鼠标或键盘松开时读取选区，在选区下方显示「评论」按钮。 */
  const onSelect = () => {
    const el = container.current;
    const a = el ? selectionAnchor(el, window.getSelection()) : null;
    if (!el || !a) {
      setPick(null);
      return;
    }
    const box = el.getBoundingClientRect();
    setPick({ quote: a.quote, prefix: a.prefix, suffix: a.suffix, top: a.rect.bottom - box.top + 4, left: Math.max(0, a.rect.left - box.left) });
  };
  const save = useApiMutation(
    (markdown: string) =>
      // 内嵌图片先转存为附件，正文里只存附件网址；baseVersion 在上传完成后再读，期间改标题沿用的版本号也算在内
      (lastSave.current = uploadDataImages(org, doc.id, markdown, uploaded.current).then((md) =>
        api<SaveResult>(`/orgs/${org}/documents/${doc.id}/content`, { method: 'PUT', body: { baseVersion: version.current, markdown: md } }),
      )),
    { silentError: true, invalidate: [qk.document(org, doc.displayKey), qk.documentRevisions(org, doc.id)] },
  );
  useImperativeHandle(ref, () => ({
    onRenamed: (v) => {
      if (v === version.current + 1) version.current = v;
    },
  }));
  const conflict = save.error instanceof ApiError && save.error.status === 409;

  const flush = () => {
    timer.current = null;
    if (blocked.current) return;
    if (inFlight.current) {
      timer.current = setTimeout(flush, AUTOSAVE_MS);
      return;
    }
    const markdown = handle.current?.getMarkdown();
    if (markdown === undefined) return;
    inFlight.current = true;
    setState('saving');
    save.mutate(markdown, {
      onSuccess: (r) => {
        version.current = r.version;
        setState(timer.current ? 'dirty' : 'saved');
      },
      onError: (e) => {
        if (e.status === 409) {
          // 停止自动保存：清掉保存期间继续输入时排上的定时器，冲突提示与只读状态一直保持到重新加载
          blocked.current = true;
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
        }
        setState('dirty');
      },
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  const onDirty = () => {
    if (!editable || blocked.current) return;
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  };

  const uploadImage = async (file: File): Promise<string> => {
    try {
      return (await apiUpload<{ attachment: Attachment }>(`/orgs/${org}/documents/${doc.id}/attachments`, file, file.name)).attachment.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '图片上传失败');
      throw e;
    }
  };

  // 卸载（站内跳转）时还有没到时间的修改：立即补发一次保存，不等结果。用 layout 清理，此时编辑器的 ref 还在。
  // 保存成功后更新缓存里的正文与版本号，回到本页时编辑器读到的是刚保存的内容。
  useLayoutEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      const markdown = handle.current?.getMarkdown();
      if (blocked.current || markdown === undefined) return;
      const base = inFlight.current && lastSave.current ? lastSave.current.then((r) => r.version) : Promise.resolve(version.current);
      void base
        .then(async (baseVersion) => {
          const md = await uploadDataImages(org, doc.id, markdown, uploaded.current);
          const r = await api<SaveResult>(`/orgs/${org}/documents/${doc.id}/content`, { method: 'PUT', body: { baseVersion, markdown: md } });
          return { ...r, markdown: md };
        })
        .then(
          (r) => {
            qc.setQueryData<{ document: DocumentDetail }>(qk.document(org, doc.displayKey), (old) =>
              old ? { document: { ...old.document, markdown: r.markdown, version: r.version, revisionNumber: r.revisionNumber } } : old,
            );
            void qc.invalidateQueries({ queryKey: qk.document(org, doc.displayKey) });
            void qc.invalidateQueries({ queryKey: qk.documentRevisions(org, doc.id) });
          },
          () => undefined,
        );
    },
    [org, doc.id, doc.displayKey, qc],
  );
  // 有未保存的修改时，关闭或刷新页面前由浏览器提示
  useEffect(() => {
    if (state === 'saved') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  return (
    <section className="rounded-md border bg-card" aria-label="正文">
      <div className="flex h-10 items-center justify-between border-b px-4 text-[13px] text-muted-foreground">
        <span>第 {doc.revisionNumber} 版</span>
        <span role="status">{saveStateLabel(state, editable)}</span>
      </div>
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b bg-destructive/5 px-4 py-2 text-[13px] text-destructive">
          <span>文档已被其他人修改，你刚才的修改没有保存。重新加载后再编辑（需要保留的内容请先复制）。</span>
          <Button size="sm" variant="outline" onClick={onReload}>
            重新加载
          </Button>
        </div>
      )}
      {save.error && !conflict && (
        <div className="px-4 pt-3">
          <FormError error={save.error} />
        </div>
      )}
      <div ref={container} className="relative px-2 py-4" onMouseUp={onSelect} onKeyUp={onSelect}>
        <DocumentBodyEditor ref={handle} initialMarkdown={doc.markdown ?? ''} editable={editable && !conflict} onDirty={onDirty} uploadImage={uploadImage} />
        {pick && (
          <Button
            size="sm"
            className="absolute z-10"
            style={{ top: pick.top, left: pick.left }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setCommenting({ quote: pick.quote, prefix: pick.prefix, suffix: pick.suffix });
              setPick(null);
            }}
          >
            评论
          </Button>
        )}
      </div>
      <AnchorCommentDialog documentId={doc.id} anchor={commenting} onClose={() => setCommenting(null)} />
    </section>
  );
}
