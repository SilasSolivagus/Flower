'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { CHECK_STATE_LABEL } from '@/lib/labels';
import { qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { CheckState, RequirementDetail } from '@/lib/types';

type Item = RequirementDetail['checkItems'][number];
export const CHECK_STATE_STYLE: Record<CheckState, string> = {
  not_started: 'text-muted-foreground',
  in_progress: 'text-amber-700 dark:text-amber-400',
  passed: 'text-primary',
  rejected: 'text-destructive',
  not_needed: 'text-muted-foreground',
};

function Rounds({ meta }: { meta: Record<string, unknown> }) {
  const rounds = Array.isArray(meta.rounds) ? (meta.rounds as Array<{ blockingCount?: number }>) : null;
  if (!rounds?.length) return null;
  return (
    <p className="text-[12px] text-muted-foreground">
      共 {rounds.length} 轮，最后一轮阻塞问题 {rounds.at(-1)?.blockingCount ?? 0} 个
    </p>
  );
}

export function CheckItems({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const [proxy, setProxy] = useState<{ item: Item; ruleIndex: number } | null>(null);
  const [decision, setDecision] = useState<'passed' | 'rejected'>('passed');
  const [note, setNote] = useState('');
  const canEdit = r.myRole !== 'viewer';
  const setState = useApiMutation((v: { key: string; state: CheckState }) => api(`/orgs/${org}/requirements/${r.id}/checks/${v.key}`, { method: 'PUT', body: { state: v.state } }), {
    invalidate: [requirementKeys(org), qk.workbench],
  });
  const sign = useApiMutation(
    (v: { key: string; decision: 'passed' | 'rejected'; ruleIndex?: number; onBehalf?: boolean; note?: string }) =>
      api(`/orgs/${org}/requirements/${r.id}/checks/${v.key}/signoffs`, { method: 'POST', body: { decision: v.decision, ruleIndex: v.ruleIndex, onBehalf: v.onBehalf, note: v.note } }),
    {
      invalidate: [requirementKeys(org), qk.workbench],
      success: '已签字',
      onSuccess: () => {
        setProxy(null);
        setNote('');
      },
    },
  );
  if (r.checkItems.length === 0) return null;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="checks-title">
      <h2 id="checks-title" className="mb-3 text-sm font-semibold">
        检查项
      </h2>
      <ul className="flex flex-col divide-y">
        {r.checkItems.map((c) => (
          <li key={c.key} className="flex flex-col gap-1.5 py-2.5" aria-label={c.label}>
            <div className="flex items-center gap-3">
              <span className="w-24 text-[13px] font-medium">{c.label}</span>
              {c.type === 'single' && canEdit ? (
                <Select value={c.state} onValueChange={(v) => setState.mutate({ key: c.key, state: v as CheckState })}>
                  <SelectTrigger className="h-8 w-28" aria-label={`${c.label}状态`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CHECK_STATE_LABEL) as CheckState[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {CHECK_STATE_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className={`text-[13px] ${CHECK_STATE_STYLE[c.state]}`}>{CHECK_STATE_LABEL[c.state]}</span>
              )}
              {c.note && <span className="truncate text-[12px] text-muted-foreground">{c.note}</span>}
            </div>
            <Rounds meta={c.meta} />
            {c.type === 'signoff' && (
              <ul className="ml-24 flex flex-col gap-1">
                {c.signers.map((s) => {
                  const latest = [...c.signoffs].reverse().find((x) => x.ruleIndex === s.index);
                  return (
                    <li key={s.index} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="w-24 text-muted-foreground">{s.label}</span>
                      {latest ? (
                        <span className={latest.decision === 'passed' ? 'text-primary' : 'text-destructive'}>
                          {latest.decision === 'passed' ? '通过' : '驳回'} · {latest.signer.displayName}
                          {latest.actedBy && `（由 ${latest.actedBy.displayName} 代签）`} · {formatDateTime(latest.at)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">未签</span>
                      )}
                      {c.canSign.includes(s.index) && (
                        <>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[12px]" disabled={sign.isPending} onClick={() => sign.mutate({ key: c.key, decision: 'passed', ruleIndex: s.index })}>
                            通过
                          </Button>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[12px]" disabled={sign.isPending} onClick={() => sign.mutate({ key: c.key, decision: 'rejected', ruleIndex: s.index })}>
                            驳回
                          </Button>
                        </>
                      )}
                      {c.canSignOnBehalf.includes(s.index) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[12px]"
                          onClick={() => {
                            setDecision('passed');
                            setNote('');
                            setProxy({ item: c, ruleIndex: s.index });
                          }}
                        >
                          代签
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={!!proxy} onOpenChange={(o) => !o && setProxy(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>代「{proxy ? proxy.item.signers[proxy.ruleIndex]?.label : ''}」签字</DialogTitle>
          </DialogHeader>
          <Select value={decision} onValueChange={(v) => setDecision(v as 'passed' | 'rejected')}>
            <SelectTrigger aria-label="结论">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="passed">通过</SelectItem>
              <SelectItem value="rejected">驳回</SelectItem>
            </SelectContent>
          </Select>
          <Textarea aria-label="备注" placeholder="例如：电话确认" value={note} onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setProxy(null)}>
              取消
            </Button>
            <Button disabled={sign.isPending} onClick={() => proxy && sign.mutate({ key: proxy.item.key, decision, ruleIndex: proxy.ruleIndex, onBehalf: true, note })}>
              确认代签
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
