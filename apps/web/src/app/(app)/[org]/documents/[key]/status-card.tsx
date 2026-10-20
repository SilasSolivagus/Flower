'use client';

import { useState } from 'react';
import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DocumentStatusBadge } from '@/components/document-status';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { briefKeys, documentKeys, qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { DocumentDetail, DocumentStatus } from '@/lib/types';

/** 状态卡片：当前状态与可流转的目标。改状态之前先保存编辑器里没到时间的修改（必填小节按服务端正文校验）。 */
export function StatusCard({ org, doc, saveEditor }: { org: string; doc: DocumentDetail; saveEditor: () => Promise<number | null> }) {
  const move = useApiMutation(
    async (to: DocumentStatus) => {
      await saveEditor();
      return api(`/orgs/${org}/documents/${doc.id}/transitions`, { method: 'POST', body: { to } });
    },
    { silentError: true, invalidate: [documentKeys(org), requirementKeys(org), briefKeys(org), qk.workbench], success: '已更新状态' },
  );
  const [confirmTo, setConfirmTo] = useState<DocumentStatus | null>(null);
  const ask = (to: DocumentStatus) => {
    if (to === 'discarded') setConfirmTo(to);
    else move.mutate(to);
  };
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-status-title">
      <h2 id="doc-status-title" className="mb-2 text-sm font-semibold">
        状态
      </h2>
      <DocumentStatusBadge status={doc.status} />
      {doc.transitions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {doc.transitions.map((to) => (
            <Button key={to} size="sm" variant="outline" disabled={move.isPending} onClick={() => ask(to)}>
              改为{DOCUMENT_STATUS_LABELS[to]}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-2">
        <FormError error={move.error} />
      </div>
      <ConfirmDialog
        open={confirmTo === 'discarded'}
        title="改为已废弃"
        description="改为已废弃后不能恢复。确认后才会改状态。"
        confirmLabel="确认废弃"
        onCancel={() => setConfirmTo(null)}
        onConfirm={() => {
          const to = confirmTo;
          setConfirmTo(null);
          if (to) move.mutate(to);
        }}
      />
    </section>
  );
}
