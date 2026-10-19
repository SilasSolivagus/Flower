'use client';

import { pendingQuestionLine } from '@/features/documents/model';
import { useOrg } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 确认人进页时的任务条：一句话说明第 16 节要确认什么。其他人看不到。 */
export function BriefTaskBanner({ org, doc }: { org: string; doc: DocumentDetail }) {
  const me = useOrg(org).data?.me;
  if (!doc.brief || !me || doc.brief.decider?.id !== me.memberId) return null;
  return (
    <div role="status" aria-label="待确认" className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-[13px] leading-6">
      <p className="font-medium">你是这份简报的确认人</p>
      <p>{pendingQuestionLine(doc.markdown ?? '')}</p>
    </div>
  );
}
