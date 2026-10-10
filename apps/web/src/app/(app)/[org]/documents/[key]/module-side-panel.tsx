'use client';

import { levelLabel } from '@/features/structure/model';
import { useLevelNames } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { Revisions } from './revisions';
import { StatusCard } from './status-card';

/** 模块文档的右侧栏：状态（使用中 / 已归档）、所属的业务域与模块、修订记录。模块文档没有负责人、覆盖需求与检查项。 */
export function ModuleSidePanel({ org, doc, onReload, saveEditor }: { org: string; doc: DocumentDetail; onReload: () => void; saveEditor: () => Promise<number | null> }) {
  const levels = useLevelNames(org, doc.productId);
  const names = levels.data?.names ?? [];
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <StatusCard org={org} doc={doc} saveEditor={saveEditor} />
      <section className="rounded-md border bg-card p-4" aria-labelledby="doc-node-title">
        <h2 id="doc-node-title" className="mb-2 text-sm font-semibold">
          所属
        </h2>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">{levelLabel(names, 1)}</dt>
          <dd className="truncate">{doc.node?.domain?.name ?? '—'}</dd>
          <dt className="text-muted-foreground">{levelLabel(names, 2)}</dt>
          <dd className="truncate">
            {doc.node?.name ?? '—'}
            {doc.node?.status === 'deprecated' && '（已停用）'}
          </dd>
        </dl>
      </section>
      <Revisions org={org} doc={doc} onRestored={onReload} saveEditor={saveEditor} />
    </aside>
  );
}
