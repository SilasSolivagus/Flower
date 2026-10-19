'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { OptionMultiSelect } from '@/components/option-multi-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseRelatedInput, relatedLinkHref } from '@/features/documents/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { ApiError, api } from '@/lib/api';
import { briefKeys, documentKeys, useApiMutation, useFunctionTags, useMembers, useOrg } from '@/lib/queries';
import type { BriefRelatedLink, DocumentDetail } from '@/lib/types';

type Patch = {
  version?: string;
  requesterMemberId?: string | null;
  deciderMemberId?: string | null;
  authorMemberId?: string | null;
  participantTagIds?: string[];
  relatedLinks?: BriefRelatedLink[];
};
const PEOPLE = [
  { field: 'requesterMemberId', key: 'requester', label: '提出人' },
  { field: 'deciderMemberId', key: 'decider', label: '确认人' },
  { field: 'authorMemberId', key: 'author', label: '作者' },
] as const;

/** 简报头部信息：版本、提出人、决策人、参与方、作者、关联文档。每改一项保存一次。 */
export function BriefHeaderCard({ org, doc }: { org: string; doc: DocumentDetail }) {
  const h = doc.brief!;
  const canEdit = doc.myRole !== 'viewer';
  const me = useOrg(org).data?.me;
  const members = useMembers(org, canEdit && canListMembers(me));
  const tags = useFunctionTags(org, canEdit && !!me && me.orgRole !== 'guest');
  const invalidate = [documentKeys(org), briefKeys(org)];
  const [version, setVersion] = useState(h.version);
  // 服务端的版本变化时（保存后、别人改了）在渲染期间同步到输入框
  const [syncedVersion, setSyncedVersion] = useState(h.version);
  if (h.version !== syncedVersion) {
    setSyncedVersion(h.version);
    setVersion(h.version);
  }
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const save = useApiMutation((body: Patch) => api(`/orgs/${org}/briefs/${doc.id}`, { method: 'PATCH', body }), { invalidate, success: '已保存' });
  const addLink = useApiMutation(
    async () => {
      const link = parseRelatedInput(target, note);
      if (!link) throw new ApiError(400, 'invalid', '请输入编号（如 PAN-PRD-3）或以 http:// 或 https:// 开头的网址', null);
      return api(`/orgs/${org}/briefs/${doc.id}`, { method: 'PATCH', body: { relatedLinks: [...h.relatedLinks, link] } });
    },
    {
      silentError: true,
      invalidate,
      success: '已添加关联文档',
      onSuccess: () => {
        setTarget('');
        setNote('');
      },
    },
  );
  const saveVersion = (e?: FormEvent) => {
    e?.preventDefault();
    const v = version.trim();
    if (save.isPending) return;
    if (!v) setVersion(h.version);
    else if (v !== h.version) save.mutate({ version: v });
  };

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="brief-header-title">
      <h2 id="brief-header-title" className="mb-3 text-sm font-semibold">
        基本信息
      </h2>
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-version">版本</Label>
          {canEdit ? (
            <form onSubmit={saveVersion}>
              <Input id="brief-version" className="h-8" maxLength={30} value={version} onChange={(e) => setVersion(e.target.value)} onBlur={() => saveVersion()} />
            </form>
          ) : (
            <p id="brief-version">{h.version}</p>
          )}
        </div>
        {PEOPLE.map((p) => (
          <div key={p.field} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{p.label}</span>
            {canEdit && members.data ? (
              <MemberPicker
                label={p.label}
                options={pickerOptions(activePeople(members.data), h[p.key])}
                value={h[p.key]?.id ?? null}
                noneLabel="未指定"
                onChange={(id) => save.mutate({ [p.field]: id } as Patch)}
              />
            ) : (
              <p>{h[p.key]?.displayName ?? '未指定'}</p>
            )}
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">参与角色</span>
          {canEdit && tags.data && (
            <div>
              <OptionMultiSelect
                label="参与角色"
                options={tags.data.map((x) => ({ id: x.id, label: x.name, color: x.color }))}
                value={h.participantTags.map((x) => x.id)}
                onChange={(ids) => save.mutate({ participantTagIds: ids })}
              />
            </div>
          )}
          <p className="text-muted-foreground">{h.participantTags.map((x) => x.name).join('、') || '未填写'}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">关联文档</span>
          {h.relatedLinks.length === 0 ? (
            <p className="text-muted-foreground">还没有关联文档</p>
          ) : (
            <ul aria-label="关联文档" className="flex flex-col gap-1">
              {h.relatedLinks.map((l, i) => {
                const href = l.kind === 'url' ? l.url : relatedLinkHref(org, l.target);
                const text = l.kind === 'url' ? l.url : l.target;
                return (
                  <li key={i} className="flex min-h-8 items-center gap-2">
                    <span className="min-w-0 flex-1 break-all">
                      {href ? (
                        l.kind === 'url' ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {text}
                          </a>
                        ) : (
                          <Link href={href} className="font-mono hover:underline">
                            {text}
                          </Link>
                        )
                      ) : (
                        <span className="font-mono">{text}</span>
                      )}
                      {l.note && <span className="ml-2 text-muted-foreground">{l.note}</span>}
                    </span>
                    {canEdit && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`移除关联 ${i + 1}`}
                        disabled={save.isPending || addLink.isPending}
                        onClick={() => save.mutate({ relatedLinks: h.relatedLinks.filter((_, j) => j !== i) })}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addLink.mutate(undefined);
              }}
            >
              <Input aria-label="引用或网址" placeholder={`${doc.productKey}-PRD-3 或 https://…`} className="h-8" value={target} onChange={(e) => setTarget(e.target.value)} />
              <div className="flex gap-2">
                <Input aria-label="说明" placeholder="说明（选填）" className="h-8" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} />
                <Button type="submit" size="sm" disabled={addLink.isPending || save.isPending || !target.trim()}>
                  添加
                </Button>
              </div>
              <FormError error={addLink.error} />
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
