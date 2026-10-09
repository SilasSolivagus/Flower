'use client';

import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CheckItems } from '@/components/check-items';
import { DocumentStatusBadge } from '@/components/document-status';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseRequirementKeys } from '@/features/documents/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { ApiError, api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { DocumentDetail, DocumentStatus } from '@/lib/types';
import { Revisions } from './revisions';

const CARD = 'rounded-md border bg-card p-4';

export function SidePanel({ org, doc, onReload, saveEditor }: { org: string; doc: DocumentDetail; onReload: () => void; saveEditor: () => Promise<number | null> }) {
  const canEdit = doc.myRole !== 'viewer';
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const invalidate = [documentKeys(org), requirementKeys(org), qk.workbench];
  const [keys, setKeys] = useState('');
  const move = useApiMutation(
    async (to: DocumentStatus) => {
      // 必填小节按服务端正文校验，先把编辑器里没到时间的修改存上
      await saveEditor();
      return api(`/orgs/${org}/documents/${doc.id}/transitions`, { method: 'POST', body: { to } });
    },
    {
      silentError: true,
      invalidate,
      success: '已更新状态',
    },
  );
  const setOwner = useApiMutation((ownerMemberId: string | null) => api(`/orgs/${org}/documents/${doc.id}`, { method: 'PATCH', body: { ownerMemberId } }), {
    invalidate: [documentKeys(org)],
    success: '已保存',
  });
  const link = useApiMutation(
    async (input: string) => {
      const wanted = parseRequirementKeys(input);
      if (wanted.length === 0) throw new ApiError(400, 'invalid', '请输入需求编号，例如 PAN-12', null);
      const ids = await Promise.all(wanted.map(async (k) => (await api<{ requirement: { id: string } }>(`/orgs/${org}/requirements/${encodeURIComponent(k)}`)).requirement.id));
      return api(`/orgs/${org}/documents/${doc.id}/requirements`, { method: 'POST', body: { requirementIds: ids } });
    },
    { silentError: true, invalidate, success: '已关联需求', onSuccess: () => setKeys('') },
  );
  const unlink = useApiMutation((requirementId: string) => api(`/orgs/${org}/documents/${doc.id}/requirements/${requirementId}`, { method: 'DELETE' }), {
    invalidate,
    success: '已移出',
  });

  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <section className={CARD} aria-labelledby="doc-status-title">
        <h2 id="doc-status-title" className="mb-2 text-sm font-semibold">
          状态
        </h2>
        <DocumentStatusBadge status={doc.status} />
        {doc.transitions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {doc.transitions.map((to) => (
              <Button key={to} size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate(to)}>
                改为{DOCUMENT_STATUS_LABELS[to]}
              </Button>
            ))}
          </div>
        )}
        <div className="mt-2">
          <FormError error={move.error} />
        </div>
      </section>

      <section className={CARD} aria-labelledby="doc-owner-title">
        <h2 id="doc-owner-title" className="mb-2 text-sm font-semibold">
          负责人
        </h2>
        {canEdit && members.data ? (
          <MemberPicker
            label="负责人"
            options={pickerOptions(activePeople(members.data), doc.owner)}
            value={doc.owner?.id ?? null}
            noneLabel="未指定"
            onChange={(id) => setOwner.mutate(id)}
          />
        ) : (
          <p className="text-[13px]">{doc.owner?.displayName ?? '未指定'}</p>
        )}
      </section>

      <section className={CARD} aria-labelledby="doc-req-title">
        <h2 id="doc-req-title" className="mb-2 text-sm font-semibold">
          覆盖的需求
        </h2>
        {doc.requirements.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">还没有覆盖需求</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {doc.requirements.map((r) => (
              <li key={r.id} className="flex h-8 items-center gap-2 text-[13px]">
                <Link href={`/${org}/requirements/${r.displayKey}`} className="min-w-0 flex-1 truncate hover:underline">
                  <span className="mr-2 font-mono text-muted-foreground">{r.displayKey}</span>
                  {r.title}
                </Link>
                {canEdit && (
                  <Button size="icon-sm" variant="ghost" aria-label={`移出 ${r.displayKey}`} disabled={unlink.isPending} onClick={() => unlink.mutate(r.id)}>
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && doc.status !== 'discarded' && (
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              link.mutate(keys);
            }}
          >
            <div className="flex gap-2">
              <Input aria-label="需求编号" placeholder="PAN-12, PAN-15" className="h-8" value={keys} onChange={(e) => setKeys(e.target.value)} />
              <Button type="submit" size="sm" disabled={link.isPending || !keys.trim()}>
                关联
              </Button>
            </div>
            <FormError error={link.error} />
          </form>
        )}
      </section>

      <CheckItems items={doc.checkItems} canEdit={canEdit} basePath={`/orgs/${org}/documents/${doc.id}/checks`} invalidate={invalidate} />

      {doc.source === 'native' && <Revisions org={org} doc={doc} onRestored={onReload} saveEditor={saveEditor} />}

      {doc.source === 'native' && doc.externalUrl && (
        <p className="break-all text-[12px] text-muted-foreground">
          原链接：
          <a href={doc.externalUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {doc.externalUrl}
          </a>
        </p>
      )}
    </aside>
  );
}
