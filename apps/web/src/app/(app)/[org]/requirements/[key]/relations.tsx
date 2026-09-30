'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { parseRequirementKey, RELATION_TYPE_OPTIONS, type RelationKind, relationPhrase } from '@/features/requirements/relations';
import { api } from '@/lib/api';
import { requirementKeys, useApiMutation, useRequirement, useRequirements } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

export function Relations({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const [type, setType] = useState<RelationKind>('related');
  const [text, setText] = useState('');
  const term = text.trim();
  const key = parseRequirementKey(term);
  const crossKey = key && !key.startsWith(`${r.productKey}-`) ? key : null;
  const sameProduct = useRequirements(org, canEdit && term && !crossKey ? r.productId : undefined, `q=${encodeURIComponent(term)}&pageSize=8&sort=updated`);
  const other = useRequirement(org, crossKey ?? '', canEdit && !!crossKey);
  const invalidate = [requirementKeys(org)];
  const add = useApiMutation((vars: { toId: string; term: string }) => api(`/orgs/${org}/requirements/${r.id}/relations`, { method: 'POST', body: { toId: vars.toId, type } }), {
    invalidate,
    silentError: true,
    success: '已添加关联',
    // 只在搜索框内容自提交以来没变过时才清空：invalidate 期间用户可能已经输入了下一次搜索。
    onSuccess: (_data, vars) => setText((cur) => (cur.trim() === vars.term ? '' : cur)),
  });
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/relations/${id}`, { method: 'DELETE' }), { invalidate, success: '已删除关联' });
  if (!canEdit && r.relations.length === 0) return null;
  const candidates = (
    crossKey
      ? other.data
        ? [{ id: other.data.id, displayKey: other.data.displayKey, title: other.data.title }]
        : []
      : (sameProduct.data?.items ?? []).map((x) => ({ id: x.id, displayKey: x.displayKey, title: x.title }))
  ).filter((c) => c.id !== r.id);

  return (
    <section className="rounded-md border bg-card p-4" aria-label="关联需求">
      <h2 className="mb-2 text-sm font-semibold">关联需求</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {r.relations.map((x) => {
          const p = relationPhrase(x.type, x.direction);
          return (
            <li key={x.id} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate">
                {p.before && <span className="text-muted-foreground">{p.before} </span>}
                <Link className="font-mono hover:underline" href={`/${org}/requirements/${x.other.displayKey}`}>
                  {x.other.displayKey}
                </Link>
                {p.after && <span className="text-muted-foreground"> {p.after}</span>} {x.other.title}
              </span>
              {canEdit && (
                <Button variant="ghost" size="sm" aria-label={`删除与 ${x.other.displayKey} 的关联`} disabled={remove.isPending} onClick={() => remove.mutate(x.id)}>
                  删除
                </Button>
              )}
            </li>
          );
        })}
        {r.relations.length === 0 && <li className="text-muted-foreground">暂无</li>}
      </ul>
      {canEdit && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <Select value={type} onValueChange={(v) => setType(v as RelationKind)}>
              <SelectTrigger className="h-8 w-28" aria-label="关联类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELATION_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.type} value={o.type}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="搜索要关联的需求"
              placeholder="本产品输入编号或标题；其他产品输入完整编号"
              className="h-8"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {term && (
            <ul className="flex flex-col text-[13px]">
              {candidates.map((c) => (
                <li key={c.id} className="flex h-8 items-center gap-2">
                  <span className="font-mono text-muted-foreground">{c.displayKey}</span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <Button size="sm" variant="outline" aria-label={`关联 ${c.displayKey}`} disabled={add.isPending} onClick={() => add.mutate({ toId: c.id, term })}>
                    关联
                  </Button>
                </li>
              ))}
              {crossKey && other.isError && <li className="text-muted-foreground">找不到 {crossKey}，或你没有查看它的权限</li>}
              {!crossKey && sameProduct.data && candidates.length === 0 && <li className="text-muted-foreground">没有找到需求</li>}
            </ul>
          )}
          <FormError error={add.error} />
        </div>
      )}
    </section>
  );
}
