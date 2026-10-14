'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/features/requirements/format';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { api } from '@/lib/api';
import { useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

type BlockerItem = RequirementDetail['blockers'][number];

/** 阻塞项区块，需求与工作项共用：新增接口路径、可写权限、刷新的查询键由调用方传入，解除走组织级 /blockers/:id/resolve。 */
export function BlockerList({
  org,
  blockers,
  canEdit,
  addPath,
  invalidate,
}: {
  org: string;
  blockers: BlockerItem[];
  canEdit: boolean;
  addPath: string;
  invalidate: ReadonlyArray<readonly unknown[]>;
}) {
  const orgQ = useOrg(org);
  const members = useMembers(org, canEdit && canListMembers(orgQ.data?.me));
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const add = useApiMutation(
    () => api(addPath, { method: 'POST', body: { description, ownerMemberId: owner } }),
    {
      invalidate,
      silentError: true,
      success: '已添加阻塞项',
      onSuccess: () => {
        setDescription('');
        setOwner(null);
      },
    },
  );
  const resolve = useApiMutation((id: string) => api(`/orgs/${org}/blockers/${id}/resolve`, { method: 'POST' }), { invalidate, success: '已解除' });
  if (!canEdit && blockers.length === 0) return null;
  const active = blockers.filter((b) => b.status === 'active');
  const resolved = blockers.filter((b) => b.status === 'resolved');
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
            <MemberPicker label="阻塞项负责人" className="h-8 w-32" noneLabel="无负责人" options={pickerOptions(people, null)} value={owner} onChange={setOwner} />
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
