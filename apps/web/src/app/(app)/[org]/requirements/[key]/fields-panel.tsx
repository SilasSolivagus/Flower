'use client';

import { OptionMultiSelect } from '@/components/option-multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { nodeOptions } from '@/features/structure/model';
import { api } from '@/lib/api';
import { requirementKeys, useApiMutation, useFields, useMembers, useNodes, useOrg } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';
import { IterationField } from './iteration-field';

const NONE = '__none';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function FieldsPanel({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const orgQ = useOrg(org);
  const canListMembers = !!orgQ.data && orgQ.data.me.orgRole !== 'guest';
  const members = useMembers(org, canListMembers);
  const nodes = useNodes(org, r.productId);
  const fields = useFields(org, r.productId);
  const canEdit = r.myRole !== 'viewer';
  const patch = useApiMutation((body: Record<string, string | null>) => api(`/orgs/${org}/requirements/${r.id}`, { method: 'PATCH', body }), { invalidate: [requirementKeys(org)] });
  const setField = useApiMutation((v: { key: string; optionIds: string[] }) => api(`/orgs/${org}/requirements/${r.id}/fields/${v.key}`, { method: 'PUT', body: { optionIds: v.optionIds } }), {
    invalidate: [requirementKeys(org)],
  });
  const people = (members.data ?? []).filter((m) => m.status === 'active' && m.kind === 'human');

  const memberSelect = (label: string, field: 'ownerMemberId' | 'requesterMemberId', current: { id: string; displayName: string } | null) => (
    <Row label={label}>
      {canEdit && canListMembers ? (
        <Select value={current?.id ?? NONE} onValueChange={(v) => patch.mutate({ [field]: v === NONE ? null : v })}>
          <SelectTrigger className="h-8" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不填</SelectItem>
            {current && !people.some((p) => p.id === current.id) && <SelectItem value={current.id}>{current.displayName}</SelectItem>}
            {people.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        (current?.displayName ?? '—')
      )}
    </Row>
  );

  const options = nodeOptions(nodes.data ?? [], r.node?.id ?? null);
  return (
    <section className="flex flex-col gap-2.5 rounded-md border bg-card p-4" aria-label="属性">
      {memberSelect('负责人', 'ownerMemberId', r.owner)}
      {memberSelect('提出人', 'requesterMemberId', r.requester)}
      <Row label="结构节点">
        {canEdit && options.length > 0 ? (
          <Select value={r.node?.id ?? NONE} onValueChange={(v) => patch.mutate({ nodeId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8" aria-label="结构节点">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不填</SelectItem>
              {options.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  <span style={{ paddingLeft: `${(n.depth - 1) * 12}px` }}>
                    {n.name}
                    {n.deprecated ? '（已停用）' : ''}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          (r.node?.name ?? '—')
        )}
      </Row>
      {r.fields.map((f) => {
        const def = fields.data?.find((x) => x.key === f.key);
        const opts = (def?.options ?? []).filter((o) => o.active || f.options.some((v) => v.id === o.id));
        return (
          <Row key={f.key} label={f.label}>
            {!canEdit || !def ? (
              f.options.map((o) => o.label).join('、') || '—'
            ) : f.cardinality === 'single' ? (
              <Select value={f.options[0]?.id ?? NONE} onValueChange={(v) => setField.mutate({ key: f.key, optionIds: v === NONE ? [] : [v] })}>
                <SelectTrigger className="h-8" aria-label={f.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不填</SelectItem>
                  {opts.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <OptionMultiSelect
                label={f.options.map((o) => o.label).join('、') || '选择'}
                options={opts.map((o) => ({ id: o.id, label: o.label, color: o.color }))}
                value={f.options.map((o) => o.id)}
                onChange={(ids) => setField.mutate({ key: f.key, optionIds: ids })}
              />
            )}
          </Row>
        );
      })}
      <Row label="迭代">
        <IterationField org={org} requirement={r} />
      </Row>
    </section>
  );
}
