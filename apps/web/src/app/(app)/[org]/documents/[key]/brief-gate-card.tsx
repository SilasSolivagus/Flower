'use client';

import { Check, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { QueryError } from '@/components/load-error';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { gateLabel } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { briefKeys, useApiMutation, useBriefGate } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 写 PRD 闸口：自动项显示结果与原因并可定位到小节；人工项可勾选，显示勾选人与时间。只作提示，不限制改状态与转 PRD。 */
export function BriefGateCard({ org, doc }: { org: string; doc: DocumentDetail }) {
  const gate = useBriefGate(org, doc.id);
  const router = useRouter();
  const pathname = usePathname();
  const canEdit = doc.myRole !== 'viewer';
  const check = useApiMutation(
    (v: { item: number; checked: boolean }) => api(`/orgs/${org}/briefs/${doc.id}/gate/${v.item}`, { method: 'PUT', body: { checked: v.checked } }),
    { invalidate: [briefKeys(org)] },
  );
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="brief-gate-title">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 id="brief-gate-title" className="text-sm font-semibold">
          写 PRD 闸口
        </h2>
        {gate.data && <span className="font-mono text-[13px] text-muted-foreground">{gateLabel(gate.data)}</span>}
      </div>
      <p className="mb-3 text-[12px] text-muted-foreground">只作提示，不限制改状态与转 PRD。</p>
      {gate.isError ? (
        <QueryError error={gate.error} noAccessMessage="没有查看这份简报的权限。" retryMessage="加载闸口失败，请重试。" onRetry={() => gate.refetch()} />
      ) : !gate.data ? (
        <Skeleton className="h-40" />
      ) : (
        <ul aria-label="闸口项" className="flex flex-col gap-2">
          {gate.data.items.map((i) => (
            <li key={i.no} aria-label={`闸口 ${i.no}`} className="flex gap-2 text-[13px] leading-5">
              {i.auto ? (
                <span role="img" aria-label={i.passed ? '通过' : '未通过'} className="mt-0.5 shrink-0">
                  {i.passed ? <Check className="size-4 text-emerald-600" aria-hidden="true" /> : <X className="size-4 text-destructive" aria-hidden="true" />}
                </span>
              ) : (
                <Checkbox
                  className="mt-0.5"
                  aria-label={`勾选闸口 ${i.no}`}
                  checked={i.passed}
                  disabled={!canEdit || check.isPending}
                  onCheckedChange={(v) => check.mutate({ item: i.no, checked: v === true })}
                />
              )}
              <div className="min-w-0 flex-1">
                <p>
                  <span className="mr-1 font-mono text-muted-foreground">{i.no}</span>
                  {i.label}
                  {i.auto && <span className="ml-1 text-[12px] text-muted-foreground">（自动检查）</span>}
                </p>
                {i.reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[12px] text-destructive">
                    {i.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                {i.section && (
                  <button
                    type="button"
                    className="mt-1 text-[12px] text-primary hover:underline"
                    onClick={() => router.replace(`${pathname}?section=${encodeURIComponent(i.section!)}`, { scroll: false })}
                  >
                    定位到「{i.section}」
                  </button>
                )}
                {i.checkedBy && i.checkedAt && (
                  <p className="text-[12px] text-muted-foreground">
                    {i.checkedBy.displayName} · {formatDateTime(i.checkedAt)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
