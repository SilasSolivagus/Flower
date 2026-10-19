'use client';

import { CheckItems } from '@/components/check-items';
import { MemberPicker } from '@/components/member-picker';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { AffectedNodes } from './affected-nodes';
import { CoveredRequirements } from './covered-requirements';
import { StatusCard } from './status-card';
import { Revisions } from './revisions';

const CARD = 'rounded-md border bg-card p-4';

export function SidePanel({ org, doc, onReload, saveEditor }: { org: string; doc: DocumentDetail; onReload: () => void; saveEditor: () => Promise<number | null> }) {
  const canEdit = doc.myRole !== 'viewer';
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const invalidate = [documentKeys(org), requirementKeys(org), qk.workbench];
  const setOwner = useApiMutation((ownerMemberId: string | null) => api(`/orgs/${org}/documents/${doc.id}`, { method: 'PATCH', body: { ownerMemberId } }), {
    invalidate: [documentKeys(org)],
    success: '已保存',
  });

  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <StatusCard org={org} doc={doc} saveEditor={saveEditor} />

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

      <CoveredRequirements org={org} doc={doc} invalidate={invalidate} />

      <AffectedNodes org={org} doc={doc} />

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
