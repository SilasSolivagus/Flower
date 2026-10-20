'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { convertMessage, documentHref } from '@/features/documents/model';
import { ApiError, api, apiText } from '@/lib/api';
import { briefKeys, documentKeys, requirementKeys, useApiMutation, useBriefGate } from '@/lib/queries';
import type { BriefConvertResult, DocumentDetail } from '@/lib/types';

/** 下载文件名：编号加标题，去掉文件名里不允许的字符。 */
const downloadName = (displayKey: string, title: string): string => {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return safe ? `${displayKey} ${safe}.md` : `${displayKey}.md`;
};

type Props = { org: string; doc: DocumentDetail; saveEditor: () => Promise<number | null> };

/** 生成 PRD 的确认：先列出没勾完的检查项（不阻止）；已生成过时主操作是打开当前 PRD，再生成是次操作。 */
function ConvertDialog({ org, doc, saveEditor, open, onOpenChange }: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const gate = useBriefGate(org, doc.id);
  const failing = gate.data?.items.filter((i) => !i.passed) ?? [];
  const converted = doc.brief!.convertedDocument;
  const convert = useApiMutation(
    async (again: boolean) => {
      await saveEditor();
      try {
        return await api<BriefConvertResult>(`/orgs/${org}/briefs/${doc.id}/convert`, { method: 'POST', body: { again } });
      } catch (e) {
        // 别处已经转过：刷新后对话框改为提示已有 PRD，并提供「再生成一份新草稿」
        if (e instanceof ApiError && e.status === 409) await qc.invalidateQueries({ queryKey: documentKeys(org) });
        throw e;
      }
    },
    {
      silentError: true,
      invalidate: [documentKeys(org), briefKeys(org), requirementKeys(org)],
      onSuccess: (r) => {
        toast.success(convertMessage(r));
        onOpenChange(false);
        router.push(documentHref(org, r.document.displayKey));
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>生成 PRD</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[13px]">
          <p>用简报内容生成一份 PRD 草稿，并挂上这份简报关联的需求。已挂在别的 PRD 上的会跳过。</p>
          {gate.data &&
            (failing.length > 0 ? (
              <div>
                <p>还有这些没勾完（仍可生成）：</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {failing.map((i) => (
                    <li key={i.no}>
                      {i.no}. {i.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p>检查项都勾完了。</p>
            ))}
          {converted && (
            <p>
              已生成{' '}
              <Link href={documentHref(org, converted.displayKey)} className="font-mono hover:underline">
                {converted.displayKey}
              </Link>
              。再生成会新建一份草稿；已关联的需求不会挂到新草稿，原来的 PRD 不动。
            </p>
          )}
          <FormError error={convert.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {converted ? (
            <>
              <Button variant="outline" disabled={convert.isPending} onClick={() => convert.mutate(true)}>
                再生成一份草稿
              </Button>
              <Button asChild>
                <Link href={documentHref(org, converted.displayKey)}>打开当前 PRD</Link>
              </Button>
            </>
          ) : (
            <Button disabled={convert.isPending} onClick={() => convert.mutate(false)}>
              生成 PRD
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 生成或打开 PRD。已生成过时主按钮是打开当前 PRD，再生成降为次按钮。 */
export function BriefPrimaryActions({ org, doc, saveEditor }: Props) {
  const [converting, setConverting] = useState(false);
  const canEdit = doc.myRole !== 'viewer';
  const converted = doc.brief!.convertedDocument;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {converted && (
          <Button size="sm" asChild>
            <Link href={documentHref(org, converted.displayKey)}>打开当前 PRD</Link>
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant={converted ? 'outline' : 'default'} disabled={doc.status === 'discarded'} onClick={() => setConverting(true)}>
            {converted ? '再生成一份草稿' : '生成 PRD'}
          </Button>
        )}
      </div>
      {converted && <p className="text-[12px] text-muted-foreground">再生成一份草稿时，已关联的需求不会挂到新草稿，原来的 PRD 不动。</p>}
      {canEdit && doc.status === 'discarded' && <p className="text-[12px] text-muted-foreground">已废弃的简报不能生成 PRD。</p>}
      {canEdit && <ConvertDialog org={org} doc={doc} saveEditor={saveEditor} open={converting} onOpenChange={setConverting} />}
    </>
  );
}

/** 操作：生成或打开 PRD、复制为文本、下载 .md（先保存编辑器里没到时间的修改，内容与上下文接口一致）。 */
export function BriefActionsCard({ org, doc, saveEditor }: Props) {
  const converted = doc.brief!.convertedDocument;
  const markdown = async () => {
    await saveEditor();
    return apiText(`/orgs/${org}/briefs/${doc.id}/context?format=markdown`);
  };
  // 剪贴板写入要在点击的同一时刻发起（Safari 在 await 之后会丢掉用户激活状态），内容以 Promise 传入
  const copy = useApiMutation(
    async () => {
      const text = markdown();
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
        } else {
          await navigator.clipboard.writeText(await text);
        }
      } catch {
        await text; // 取内容本身失败时抛出接口的中文错误
        throw new Error('复制失败，请改用「下载 .md」');
      }
    },
    { success: '已复制文本' },
  );
  const download = useApiMutation(async () => {
    const url = URL.createObjectURL(new Blob([await markdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName(doc.displayKey, doc.title);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="brief-actions-title">
      <h2 id="brief-actions-title" className="mb-2 text-sm font-semibold">
        操作
      </h2>
      {converted && (
        <p className="mb-2 text-[13px]">
          已生成{' '}
          <Link href={documentHref(org, converted.displayKey)} className="font-mono hover:underline">
            {converted.displayKey}
          </Link>{' '}
          {converted.title}
        </p>
      )}
      {/* 窄屏的主按钮在标题下的进度条里，这里只在 xl 及以上显示，避免同时出现两个实心按钮。 */}
      <div className="max-xl:hidden">
        <BriefPrimaryActions org={org} doc={doc} saveEditor={saveEditor} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={copy.isPending} onClick={() => copy.mutate(undefined)}>
          复制为文本
        </Button>
        <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => download.mutate(undefined)}>
          下载 .md
        </Button>
      </div>
    </section>
  );
}
