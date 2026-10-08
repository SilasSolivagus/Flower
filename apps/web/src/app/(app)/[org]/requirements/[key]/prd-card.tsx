'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { documentHref } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';
import { CreateDocumentDialog } from '../../documents/create-dialog';

/** 需求所挂的 PRD：标题、状态、来源；没挂时可以新建或关联已有 PRD。 */
export function PrdCard({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const doc = r.changeDocument;
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [key, setKey] = useState('');
  const invalidate = [requirementKeys(org), documentKeys(org), qk.workbench];
  const unlink = useApiMutation(() => api(`/orgs/${org}/documents/${doc!.id}/requirements/${r.id}`, { method: 'DELETE' }), { invalidate, success: '已移出 PRD' });
  const link = useApiMutation(
    async (k: string) => {
      const found = await api<{ document: { id: string } }>(`/orgs/${org}/documents/${encodeURIComponent(k.trim().toUpperCase())}`);
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
      {doc ? (
        <div className="flex flex-col gap-2">
          <Link href={documentHref(org, doc.displayKey)} className="text-[13px] hover:underline">
            <span className="mr-2 font-mono text-muted-foreground">{doc.displayKey}</span>
            {doc.title}
          </Link>
          <div className="flex items-center gap-3">
            <DocumentStatusBadge status={doc.status} />
            <span className="text-[12px] text-muted-foreground">{doc.source === 'native' ? 'Flower 文档' : '外部链接'}</span>
          </div>
          {canEdit && (
            <Button size="sm" variant="ghost" className="self-start" disabled={unlink.isPending} onClick={() => unlink.mutate(undefined)}>
              移出 PRD
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted-foreground">还没有挂 PRD</p>
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
