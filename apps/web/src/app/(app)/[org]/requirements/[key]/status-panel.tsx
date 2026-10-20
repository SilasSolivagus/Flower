'use client';

import { useState } from 'react';
import { DisabledReason } from '@/components/disabled-reason';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { primaryTransitionTo } from '@/features/requirements/transitions';
import { api } from '@/lib/api';
import { qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

export function StatusPanel({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const [forcing, setForcing] = useState<{ to: string; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const state = r.workflow.states.find((s) => s.key === r.stateKey);
  const move = useApiMutation((vars: { to: string; force?: boolean; reason?: string }) => api(`/orgs/${org}/requirements/${r.id}/transitions`, { method: 'POST', body: vars }), {
    invalidate: [requirementKeys(org), qk.workbench],
    success: '已流转',
  });
  const force = useApiMutation((vars: { to: string; reason: string }) => api(`/orgs/${org}/requirements/${r.id}/transitions`, { method: 'POST', body: { ...vars, force: true } }), {
    invalidate: [requirementKeys(org), qk.workbench],
    silentError: true,
    success: '已强制流转',
    onSuccess: () => {
      setForcing(null);
      setReason('');
    },
  });
  const canEdit = r.myRole !== 'viewer';
  const primaryTo = primaryTransitionTo(r.stateKey, r.workflow.states, r.transitions);
  const closeForcing = () => {
    setForcing(null);
    setReason('');
    force.reset();
  };

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="status-title">
      <h2 id="status-title" className="mb-3 text-sm font-semibold">
        状态
      </h2>
      <p className="mb-3 flex items-center gap-2 text-base font-medium" data-testid="current-state">
        <span className="size-2.5 rounded-full" style={{ background: state?.color }} aria-hidden="true" />
        {state?.label ?? r.stateKey}
      </p>
      {!canEdit && r.transitions.length > 0 && <p className="mb-2 text-[12px] text-muted-foreground">只有编辑可以改状态</p>}
      <ul className="flex flex-col gap-2" aria-label="可流转到">
        {r.transitions.map((t) => {
          const unmetText = t.unmet.map((u) => u.message).join('；');
          let reason: string | undefined;
          if (!t.allowed) reason = unmetText || '现在不能改到这个状态';
          else if (!canEdit) reason = '只有编辑可以改状态';
          const emphasis = t.to === primaryTo ? 'primary' : 'secondary';
          const button = (
            <Button
              size="sm"
              variant={emphasis === 'primary' ? 'default' : 'outline'}
              data-emphasis={emphasis}
              disabled={!t.allowed || !canEdit || move.isPending}
              onClick={() => move.mutate({ to: t.to })}
            >
              {t.label}
            </Button>
          );
          return (
          <li key={t.to} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {!t.allowed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex" tabIndex={0} title={reason}>
                      {button}
                    </span>
                  </TooltipTrigger>
                  {unmetText && <TooltipContent>{unmetText}</TooltipContent>}
                </Tooltip>
              ) : !canEdit ? (
                <span className="inline-flex" title={reason}>
                  {button}
                </span>
              ) : (
                button
              )}
              {!t.allowed && r.canForce && (
                <button type="button" className="text-[12px] text-muted-foreground underline" onClick={() => setForcing({ to: t.to, label: t.label })}>
                  强制流转
                </button>
              )}
            </div>
            {t.unmet.length > 0 && (
              <ul className="pl-1 text-[12px] text-muted-foreground">
                {t.unmet.map((u, i) => (
                  <li key={i}>· {u.message}</li>
                ))}
              </ul>
            )}
          </li>
          );
        })}
      </ul>
      <Dialog open={!!forcing} onOpenChange={(o) => !o && closeForcing()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>强制流转到「{forcing?.label}」</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">会跳过流转条件，并在历史中记录原因。</p>
          <Textarea aria-label="原因" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <FormError error={force.error} />
          <DialogFooter>
            <Button variant="outline" onClick={closeForcing}>
              取消
            </Button>
            <DisabledReason disabled={!reason.trim()} reason="请先填写原因">
              <Button disabled={!reason.trim() || force.isPending} onClick={() => force.mutate({ to: forcing!.to, reason })}>
                确认流转
              </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
