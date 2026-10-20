'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { Button } from '@/components/ui/button';
import { documentHref, gateLabel } from '@/features/documents/model';
import type { RequirementDetail } from '@/lib/types';
import { CreateBriefDialog } from '../../documents/create-brief-dialog';

/** 需求所挂的简报。已生成 PRD 时主按钮是打开它，检查进度是次要文字。没挂时可以新建并自动覆盖这条需求。 */
export function BriefCard({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const brief = r.brief;
  const [creating, setCreating] = useState(false);
  const generated = brief?.convertedDocument ?? null;
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="req-brief-title">
      <h2 id="req-brief-title" className="mb-2 text-sm font-semibold">
        简报
      </h2>
      {brief ? (
        <div className="flex flex-col gap-2">
          <Link href={documentHref(org, brief.displayKey)} className="text-[13px] hover:underline">
            <span className="mr-2 font-mono text-muted-foreground">{brief.displayKey}</span>
            {brief.title}
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <DocumentStatusBadge status={brief.status} />
            <span className="font-mono text-[12px] text-muted-foreground">检查记录 {gateLabel(brief.gate)}</span>
          </div>
          {generated && (
            <Button size="sm" className="self-start" asChild>
              <Link href={documentHref(org, generated.displayKey)}>已生成 · 打开</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted-foreground">还没有简报</p>
          {canEdit && (
            <Button size="sm" className="self-start" onClick={() => setCreating(true)}>
              新建简报
            </Button>
          )}
          <CreateBriefDialog org={org} productId={r.productId} open={creating} onOpenChange={setCreating} initialTitle={r.title} requirementIds={[r.id]} />
        </div>
      )}
    </section>
  );
}
