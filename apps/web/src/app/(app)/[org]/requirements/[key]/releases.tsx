'use client';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { releaseStatusText } from '@/lib/labels';
import { releaseKeys, requirementKeys, useApiMutation, useReleases } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

export function Releases({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const all = useReleases(org, `product=${r.productId}`, canEdit);
  const invalidate = [requirementKeys(org), releaseKeys(org)];
  const link = useApiMutation((releaseId: string) => api(`/orgs/${org}/releases/${releaseId}/requirements/${r.id}`, { method: 'PUT' }), {
    invalidate,
    success: '已关联版本',
  });
  const unlink = useApiMutation((releaseId: string) => api(`/orgs/${org}/releases/${releaseId}/requirements/${r.id}`, { method: 'DELETE' }), {
    invalidate,
    success: '已解除关联',
  });
  if (!canEdit && r.releases.length === 0) return null;
  const candidates = (all.data ?? []).filter((x) => !r.releases.some((y) => y.id === x.id));
  return (
    <section className="rounded-md border bg-card p-4" aria-label="发布版本">
      <h2 className="mb-2 text-sm font-semibold">发布版本</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {r.releases.map((x) => (
          <li key={x.id} className="flex items-center gap-1">
            <span className="min-w-0 flex-1">
              {x.platform?.label} <span className="font-mono">{x.versionName}</span>
              <span className="text-muted-foreground"> · {releaseStatusText(x)}</span>
            </span>
            {canEdit && (
              <Button variant="ghost" size="sm" aria-label={`解除 ${x.versionName}`} disabled={unlink.isPending} onClick={() => unlink.mutate(x.id)}>
                解除
              </Button>
            )}
          </li>
        ))}
        {r.releases.length === 0 && <li className="text-muted-foreground">未关联</li>}
      </ul>
      {canEdit && candidates.length > 0 && (
        <Select value="" onValueChange={(id) => link.mutate(id)}>
          <SelectTrigger className="mt-2 h-8" aria-label="关联发布版本">
            <SelectValue placeholder="关联发布版本…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {[x.platform?.label, x.versionName, x.iteration && `（${x.iteration.name}）`].filter(Boolean).join(' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}
