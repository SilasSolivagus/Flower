'use client';

import { X } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { activePeople, canListMembers } from '@/features/members/model';
import { api } from '@/lib/api';
import { qk, requirementKeys, useApiMutation, useFields, useFunctionTags, useMembers, useOrg } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

const NONE = 'none';

/** 需求的分配：某职能由谁负责（可限定平台）。会签检查项的「等我签字」按这里的分配推送。 */
export function Assignments({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const orgQ = useOrg(org);
  // 选择成员和职能标签需要读取成员列表，访客读不到，因此访客只读
  const canEdit = r.myRole !== 'viewer' && canListMembers(orgQ.data?.me);
  const members = useMembers(org, canEdit);
  const tags = useFunctionTags(org, canEdit);
  const fields = useFields(org, r.productId, canEdit);
  const platformOptions = (fields.data?.find((f) => f.key === 'platform')?.options ?? []).filter((o) => o.active);
  const [tagId, setTagId] = useState(NONE);
  const [memberId, setMemberId] = useState(NONE);
  const [platformId, setPlatformId] = useState(NONE);
  // 分配改变「等我签字」的推送对象：刷新需求详情、评审表（都在 requirementKeys 下）和工作台
  const invalidate = [requirementKeys(org), qk.workbench];
  const add = useApiMutation(
    () =>
      api(`/orgs/${org}/requirements/${r.id}/assignments`, {
        method: 'POST',
        body: { memberId, functionTagId: tagId, platformOptionId: platformId === NONE ? null : platformId },
      }),
    {
      invalidate,
      silentError: true,
      success: '已添加分配',
      onSuccess: () => {
        setMemberId(NONE);
        setPlatformId(NONE);
      },
    },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/assignments/${id}`, { method: 'DELETE' }), {
    invalidate,
    silentError: true,
    success: '已删除分配',
    onSuccess: () => add.reset(),
  });
  if (!canEdit && r.assignments.length === 0) return null;

  return (
    <section className="rounded-md border bg-card p-4" aria-label="分配">
      <h2 className="mb-2 text-sm font-semibold">分配</h2>
      {r.assignments.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有分配</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {r.assignments.map((a) => {
            const label = [a.member.displayName, a.functionTag?.name, a.platform?.label].filter(Boolean).join(' · ');
            return (
              <li key={a.id} className="flex items-center gap-2">
                <span className="flex-1">{label}</span>
                {canEdit && (
                  <Button variant="ghost" size="icon-xs" aria-label={`删除分配：${label}`} disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>
                    <X aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <form
          className="mt-3 flex flex-col gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined);
          }}
        >
          <Select value={tagId} onValueChange={setTagId}>
            <SelectTrigger className="h-8" aria-label="分配职能">
              <SelectValue placeholder="选择职能" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE} disabled>
                选择职能
              </SelectItem>
              {(tags.data ?? []).map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={memberId} onValueChange={setMemberId}>
            <SelectTrigger className="h-8" aria-label="分配成员">
              <SelectValue placeholder="选择成员" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE} disabled>
                选择成员
              </SelectItem>
              {activePeople(members.data ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {platformOptions.length > 0 && (
            <Select value={platformId} onValueChange={setPlatformId}>
              <SelectTrigger className="h-8" aria-label="分配平台">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>不限平台</SelectItem>
                {platformOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button type="submit" size="sm" variant="outline" disabled={tagId === NONE || memberId === NONE || add.isPending}>
            添加分配
          </Button>
          <FormError error={add.error ?? remove.error} />
        </form>
      )}
    </section>
  );
}
