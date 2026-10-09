'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sourceLabel } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 外部 PRD：链接卡片、修改链接、「转为 Flower 文档」入口（onConvert 由 Task 13 的导入对话框提供）。 */
export function ExternalCard({ org, doc, onConvert }: { org: string; doc: DocumentDetail; onConvert?: () => void }) {
  const canEdit = doc.myRole !== 'viewer';
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const patch = useApiMutation((externalUrl: string) => api(`/orgs/${org}/documents/${doc.id}`, { method: 'PATCH', body: { externalUrl } }), {
    silentError: true,
    invalidate: [documentKeys(org)],
    success: '已更新链接',
    onSuccess: () => setEditing(false),
  });
  return (
    <section aria-label="外部文档" className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <ExternalLink className="size-4" aria-hidden="true" />
        {sourceLabel(doc)}
      </p>
      <a href={doc.externalUrl ?? undefined} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">
        {doc.externalUrl}
      </a>
      <p className="text-[13px] text-muted-foreground">正文在外部平台。状态、覆盖需求、检查项与评论在 Flower 里处理；需要在 Flower 里编辑、留修订记录时，可以转为 Flower 文档（原链接保留）。</p>
      {canEdit &&
        (editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate(url);
            }}
          >
            <Input aria-label="文档网址" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
            <FormError error={patch.error} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={patch.isPending}>
                保存链接
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setUrl(doc.externalUrl ?? '');
                patch.reset();
                setEditing(true);
              }}
            >
              修改链接
            </Button>
            {onConvert && (
              <Button size="sm" onClick={onConvert}>
                转为 Flower 文档
              </Button>
            )}
          </div>
        ))}
    </section>
  );
}
