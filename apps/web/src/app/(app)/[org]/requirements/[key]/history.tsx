'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, stateLabel } from '@/features/requirements/format';
import { HISTORY_PREVIEW_COUNT, previewHistory } from '@/features/requirements/history-preview';
import type { RequirementDetail } from '@/lib/types';

export function History({ requirement: r }: { requirement: RequirementDetail }) {
  const [expanded, setExpanded] = useState(false);
  const { visible } = previewHistory(r.history, expanded);
  const canToggle = r.history.length > HISTORY_PREVIEW_COUNT;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="history-title">
      <h2 id="history-title" className="mb-3 text-sm font-semibold">
        状态历史
      </h2>
      <ol className="flex flex-col gap-2">
        {visible.map((h, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-mono text-xs text-muted-foreground">{formatDateTime(h.at)}</span>
            <span>
              {h.from === null ? `创建为「${stateLabel(r.workflow.states, h.to)}」` : `「${stateLabel(r.workflow.states, h.from)}」→「${stateLabel(r.workflow.states, h.to)}」`}
            </span>
            {h.actor && <span className="text-muted-foreground">{h.actor.displayName}</span>}
            {h.forced && <Badge variant="destructive">强制</Badge>}
            {h.reason && <span className="text-muted-foreground">原因：{h.reason}</span>}
          </li>
        ))}
      </ol>
      {canToggle && (
        <button type="button" className="mt-2 text-[13px] text-primary" onClick={() => setExpanded((open) => !open)}>
          {expanded ? `只看最近 ${HISTORY_PREVIEW_COUNT} 条` : `展开全部（${r.history.length} 条）`}
        </button>
      )}
    </section>
  );
}
