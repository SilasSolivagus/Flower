'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDate } from '@/features/requirements/format';
import { activePeople, canListMembers } from '@/features/members/model';
import { api } from '@/lib/api';
import { iterationKeys, requirementKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

const NONE = '__none';

export function Blockers({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const orgQ = useOrg(org);
  const members = useMembers(org, canEdit && canListMembers(orgQ.data?.me));
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState(NONE);
  const invalidate = [requirementKeys(org), iterationKeys(org)];
  const add = useApiMutation(
    () => api(`/orgs/${org}/requirements/${r.id}/blockers`, { method: 'POST', body: { description, ownerMemberId: owner === NONE ? null : owner } }),
    {
      invalidate,
      silentError: true,
      success: '已添加阻塞项',
      onSuccess: () => {
        setDescription('');
        setOwner(NONE);
      },
    },
  );
  const resolve = useApiMutation((id: string) => api(`/orgs/${org}/blockers/${id}/resolve`, { method: 'POST' }), { invalidate, success: '已解除' });
  if (!canEdit && r.blockers.length === 0) return null;
  const active = r.blockers.filter((b) => b.status === 'active');
  const resolved = r.blockers.filter((b) => b.status === 'resolved');
  const people = activePeople(members.data ?? []);

  return (
    <section className="rounded-md border bg-card p-4" aria-label="阻塞项">
      <h2 className="mb-2 text-sm font-semibold">
        阻塞项
        {active.length > 0 && <span className="ml-2 text-destructive">{active.length}</span>}
      </h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {active.map((b) => (
          <li key={b.id} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {b.description}
              <span className="text-muted-foreground">
                {b.owner && ` · ${b.owner.displayName}`} · <span className="font-mono">{formatDate(b.createdAt)}</span>
              </span>
            </span>
            {canEdit && (
              <Button variant="ghost" size="sm" aria-label={`解除：${b.description}`} disabled={resolve.isPending} onClick={() => resolve.mutate(b.id)}>
                解除
              </Button>
            )}
          </li>
        ))}
        {active.length === 0 && <li className="text-muted-foreground">没有未解除的阻塞项</li>}
      </ul>
      {resolved.length > 0 && (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">已解除 {resolved.length} 条</summary>
          <ul className="mt-1 flex flex-col gap-1 pl-4 text-muted-foreground">
            {resolved.map((b) => (
              <li key={b.id}>
                <span className="line-through">{b.description}</span>
                {b.resolvedAt && (
                  <>
                    {' · '}
                    <span className="font-mono">{formatDate(b.resolvedAt)}</span> 解除
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canEdit && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined);
          }}
        >
          <Input aria-label="新阻塞项" placeholder="描述阻塞原因" className="h-8" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          {people.length > 0 && (
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger className="h-8 w-32" aria-label="阻塞项负责人">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>无负责人</SelectItem>
                {people.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button type="submit" size="sm" variant="outline" disabled={!description.trim() || add.isPending}>
            添加
          </Button>
        </form>
      )}
      <FormError error={add.error} />
    </section>
  );
}
