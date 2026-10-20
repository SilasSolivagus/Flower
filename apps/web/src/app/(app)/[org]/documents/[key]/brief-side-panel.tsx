'use client';

import { briefKeys, documentKeys, qk, requirementKeys } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { BriefActionsCard } from './brief-actions-card';
import { BriefGateCard } from './brief-gate-card';
import { BriefHeaderCard } from './brief-header-card';
import { CoveredRequirements } from './covered-requirements';
import { Revisions } from './revisions';
import { StatusCard } from './status-card';

/** 简报详情的侧栏：状态、头部信息、覆盖的需求、写 PRD 闸口、操作、修订。 */
export function BriefSidePanel({ org, doc, onReload, saveEditor }: { org: string; doc: DocumentDetail; onReload: () => void; saveEditor: () => Promise<number | null> }) {
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <StatusCard org={org} doc={doc} saveEditor={saveEditor} />
      <BriefHeaderCard org={org} doc={doc} />
      <CoveredRequirements org={org} doc={doc} invalidate={[documentKeys(org), requirementKeys(org), briefKeys(org), qk.workbench]} />
      <BriefGateCard org={org} doc={doc} />
      <BriefActionsCard org={org} doc={doc} saveEditor={saveEditor} />
      <Revisions org={org} doc={doc} onRestored={onReload} saveEditor={saveEditor} unit="次" />
    </aside>
  );
}
