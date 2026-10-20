'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { documentHref } from '@/features/documents/model';
import { ApiError, api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';
import { CreateDocumentDialog } from '../../documents/create-dialog';

/** 本需求挂过的变更 PRD：当前置顶，历史同样可点开。没挂当前这份时可以新建或关联已有 PRD。 */
export function PrdCard({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const current = r.changeDocument;
  const docs = r.changeDocuments;
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [key, setKey] = useState('');
  const invalidate = [requirementKeys(org), documentKeys(org), qk.workbench];
  const unlink = useApiMutation(() => api(`/orgs/${org}/documents/${current!.id}/requirements/${r.id}`, { method: 'DELETE' }), { invalidate, success: '已移出 PRD' });
  const link = useApiMutation(
    async (k: string) => {
      const found = await api<{ document: { id: string; kind: string } }>(`/orgs/${org}/documents/${encodeURIComponent(k.trim().toUpperCase())}`);
      // 简报与 PRD 编号同形（PAN-B-n / PAN-PRD-n），这里只接受变更 PRD，免得把需求挂到简报上
      if (found.document.kind !== 'change') throw new ApiError(400, 'invalid', `请输入 PRD 编号，例如 ${r.productKey}-PRD-1`, null);
      return api(`/orgs/${org}/documents/${found.document.id}/requirements`, { method: 'POST', body: { requirementIds: [r.id] } });
    },
    {
      silentError: true,
      invalidate,
      success: '已关联 PRD',
      onSuccess: () => {
        setLinking(false);
        setKey('');
      },
    },
  );
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="req-prd-title">
      <h2 id="req-prd-title" className="mb-2 text-sm font-semibold">
        PRD
      </h2>
      {docs.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-3" aria-label="挂过的 PRD">
          {docs.map((doc) => (
            <li key={doc.id} className="flex min-w-0 flex-col gap-1" aria-current={doc.current ? 'true' : undefined}>
              <div className="flex min-w-0 items-center gap-2">
                <Link
                  href={documentHref(org, doc.displayKey)}
                  className={doc.current ? 'flex min-w-0 items-baseline gap-2 text-[13px] font-medium hover:underline' : 'flex min-w-0 items-baseline gap-2 text-[13px] text-muted-foreground hover:underline'}
                >
                  <span className="shrink-0 font-mono">{doc.displayKey}</span>
                  <span className="min-w-0 truncate">{doc.title}</span>
                </Link>
                {doc.current && <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs">当前</span>}
              </div>
              <div className="flex items-center gap-3">
                <DocumentStatusBadge status={doc.status} />
                {doc.current && <span className="text-[12px] text-muted-foreground">{doc.source === 'native' ? 'Flower 文档' : '外部链接'}</span>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 text-[13px] text-muted-foreground">还没有挂 PRD</p>
      )}
      {current && canEdit && (
        <Button size="sm" variant="ghost" className="self-start" disabled={unlink.isPending} onClick={() => unlink.mutate(undefined)}>
          移出 PRD
        </Button>
      )}
      {!current && (
        <div className="flex flex-col gap-2">
          {canEdit &&
            (linking ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  link.mutate(key);
                }}
              >
                <Input aria-label="PRD 编号" placeholder={`${r.productKey}-PRD-1`} className="h-8" value={key} onChange={(e) => setKey(e.target.value)} />
                <FormError error={link.error} />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={link.isPending || !key.trim()}>
                    关联
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setLinking(false)}>
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setCreating(true)}>
                  新建 PRD
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    link.reset();
                    setLinking(true);
                  }}
                >
                  关联已有 PRD
                </Button>
              </div>
            ))}
          <CreateDocumentDialog org={org} productId={r.productId} open={creating} onOpenChange={setCreating} initialTitle={r.title} requirementIds={[r.id]} />
        </div>
      )}
    </section>
  );
}
