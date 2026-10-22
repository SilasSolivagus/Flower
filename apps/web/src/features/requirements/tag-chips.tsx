'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isOrgAdminRole } from '@/features/shell/nav';
import { SWATCHES } from '@/lib/labels';
import { api } from '@/lib/api';
import { qk, requirementKeys, useApiMutation, useOrg, useRequirementTags } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

/** 需求详情标题下的标签。编辑者可挂已有标签；只有组织管理员能新建字典项。卸下不二次确认。 */
export function RequirementTagChips({ org, requirement }: { org: string; requirement: RequirementDetail }) {
  const canEdit = requirement.myRole !== 'viewer';
  const orgQ = useOrg(org);
  const admin = !!orgQ.data && isOrgAdminRole(orgQ.data.me.orgRole);
  const dictionary = useRequirementTags(org, canEdit);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const attached = requirement.tags;
  const invalidate = [requirementKeys(org), qk.requirementTags(org)];
  const setTags = useApiMutation(
    (tagIds: string[]) => api(`/orgs/${org}/requirements/${requirement.id}/tags`, { method: 'PUT', body: { tagIds } }),
    { invalidate, success: '已更新标签' },
  );
  const create = useApiMutation(
    () => api<{ tag: { id: string } }>(`/orgs/${org}/requirement-tags`, { method: 'POST', body: { name, color: SWATCHES[0] } }),
    {
      invalidate,
      onSuccess: (d) => {
        setName('');
        setTags.mutate([...attached.map((t) => t.id), d.tag.id]);
      },
    },
  );
  const available = (dictionary.data ?? []).filter((t) => !attached.some((a) => a.id === t.id));

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="需求标签">
      {attached.length === 0 && <span className="text-[13px] text-muted-foreground">暂无标签</span>}
      {attached.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[13px]" style={{ borderColor: t.color }}>
          <span className="size-2 rounded-full" style={{ background: t.color }} />
          {t.name}
          {canEdit && (
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`移除标签 ${t.name}`} onClick={() => setTags.mutate(attached.filter((x) => x.id !== t.id).map((x) => x.id))}>
              ×
            </button>
          )}
        </span>
      ))}
      {canEdit && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline">
              添加
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-64 flex-col gap-2">
            {available.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">没有可挂的标签</p>
            ) : (
              <ul className="flex max-h-48 flex-col">
                {available.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-muted"
                      onClick={() => {
                        setTags.mutate([...attached.map((x) => x.id), t.id]);
                        setOpen(false);
                      }}
                    >
                      <span className="size-2 rounded-full" style={{ background: t.color }} />
                      {t.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {admin && (
              <form
                className="flex gap-2 border-t pt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate(undefined);
                }}
              >
                <Input aria-label="新标签名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="新建标签" className="h-8" maxLength={20} required />
                <Button type="submit" size="sm" disabled={create.isPending}>
                  新建
                </Button>
              </form>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
