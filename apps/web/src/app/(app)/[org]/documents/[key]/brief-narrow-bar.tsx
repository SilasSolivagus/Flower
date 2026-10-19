'use client';

import { DocumentStatusBadge } from '@/components/document-status';
import { gateBreakdown, gateLabel } from '@/features/documents/model';
import { useBriefGate } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { BriefPrimaryActions } from './brief-actions-card';

type Props = { org: string; doc: DocumentDetail; saveEditor: () => Promise<number | null> };

/** 窄屏把状态、检查进度和主操作放在标题下，不必滚完 18 节才看到侧栏。 */
export function BriefNarrowBar({ org, doc, saveEditor }: Props) {
  const gate = useBriefGate(org, doc.id);
  return (
    <section aria-label="简报进度" className="flex flex-col gap-3 rounded-md border bg-card p-4 xl:hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <DocumentStatusBadge status={doc.status} />
        {gate.data && (
          <span className="font-mono text-[13px] text-muted-foreground">
            检查 {gateLabel(gate.data)}
            <span className="ml-2 text-[12px]">{gateBreakdown(gate.data.items)}</span>
          </span>
        )}
      </div>
      <BriefPrimaryActions org={org} doc={doc} saveEditor={saveEditor} />
    </section>
  );
}
