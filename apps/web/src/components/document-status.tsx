import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { DOCUMENT_STATUS_COLOR } from '@/features/documents/model';
import type { DocumentStatus } from '@/lib/types';

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span className="size-2 rounded-full" style={{ background: DOCUMENT_STATUS_COLOR[status] }} aria-hidden="true" />
      {DOCUMENT_STATUS_LABELS[status]}
    </span>
  );
}
