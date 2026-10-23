'use client';

import { ChevronDown } from 'lucide-react';
import { Fragment, useState } from 'react';
import { DisabledReason } from '@/components/disabled-reason';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { primaryStatusAction, transitionDisabledReason } from '@/features/requirements/status-menu';
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
  const primary = primaryStatusAction(canEdit, primaryTo, r.transitions);
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
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium" data-testid="current-state">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: state?.color }} aria-hidden="true" />
          {state?.label ?? r.stateKey}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {r.transitions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  变更状态
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72" aria-label="可流转到">
                {r.transitions.map((t) => {
                  const disabledReason = transitionDisabledReason(t, canEdit);
                  return (
                    <Fragment key={t.to}>
                      <DropdownMenuItem
                        disabled={!!disabledReason || move.isPending}
                        className="items-start whitespace-normal"
                        onSelect={() => move.mutate({ to: t.to })}
                      >
                        <span className="flex min-w-0 flex-col items-start gap-0.5">
                          <span>{t.label}</span>
                          {disabledReason && <span className="text-[12px] font-normal leading-4 text-muted-foreground">{disabledReason}</span>}
                        </span>
                      </DropdownMenuItem>
                      {!t.allowed && r.canForce && canEdit && (
                        <DropdownMenuItem onSelect={() => setForcing({ to: t.to, label: t.label })}>强制流转到「{t.label}」</DropdownMenuItem>
                      )}
                    </Fragment>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {primary && (
            <Button type="button" size="sm" data-emphasis="primary" disabled={move.isPending} onClick={() => move.mutate({ to: primary.to })}>
              {primary.label}
            </Button>
          )}
        </div>
      </div>
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
