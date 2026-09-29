'use client';

import { useState } from 'react';
import { type ForceJoinTarget, ForceJoinDialog } from '@/components/force-join-dialog';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, unmetFrom } from '@/lib/api';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import { iterationKeys, requirementKeys, useApiMutation, useProductIterations } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

const NONE = '__none';

export function IterationField({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const iterations = useProductIterations(org, r.productId);
  const [forcing, setForcing] = useState<ForceJoinTarget | null>(null);
  const set = useApiMutation(
    (iterationId: string | null) => api(`/orgs/${org}/requirements/${r.id}/iteration`, { method: 'PUT', body: { iterationId } }),
    { invalidate: [requirementKeys(org), iterationKeys(org)], silentError: true, success: '已更新迭代' },
  );
  if (r.myRole === 'viewer') return <>{r.iteration?.name ?? '未排期'}</>;
  const choices = (iterations.data ?? []).filter((i) => i.status === 'planning' || i.status === 'active' || i.id === r.iteration?.id);
  const failed = set.error?.code === 'precondition_failed' ? choices.find((i) => i.id === set.variables) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Select value={r.iteration?.id ?? NONE} onValueChange={(v) => set.mutate(v === NONE ? null : v)}>
        <SelectTrigger className="h-8" aria-label="迭代">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>未排期</SelectItem>
          {choices.map((i) => (
            <SelectItem key={i.id} value={i.id}>
              {i.type === 'special' ? `专项：${i.name}` : i.name}
              {i.status !== 'planning' && i.status !== 'active' ? `（${ITERATION_STATUS_LABEL[i.status]}）` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!r.iteration && r.joinIterationUnmet.length > 0 && (
        <ul aria-label="加入迭代的条件" className="text-[12px] text-muted-foreground">
          {r.joinIterationUnmet.map((u, i) => (
            <li key={i}>· {u.message}</li>
          ))}
        </ul>
      )}
      <FormError error={set.error} />
      {failed && r.canForce && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setForcing({ requirementId: r.id, requirementLabel: r.displayKey, iterationId: failed.id, iterationName: failed.name, unmet: unmetFrom(set.error?.details) })}
        >
          强制加入
        </Button>
      )}
      <ForceJoinDialog
        org={org}
        target={forcing}
        onClose={() => {
          setForcing(null);
          set.reset();
        }}
      />
    </div>
  );
}
