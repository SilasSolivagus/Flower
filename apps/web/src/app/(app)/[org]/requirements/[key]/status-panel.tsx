'use client';

import { ChevronDown } from 'lucide-react';
import { Fragment, useState } from 'react';
import { DisabledReason } from '@/components/disabled-reason';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { primaryTransitionTo, statusMenuEntries } from '@/features/requirements/transitions';
import { api } from '@/lib/api';
import { qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

/** 一行状态：色点 + 当前文案，至多一个主操作，其余下一态在「变更状态」里。非法流转停在菜单里并写短因。 */
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
  const entries = statusMenuEntries(r.transitions, canEdit);
  const primaryTo = primaryTransitionTo(r.stateKey, r.workflow.states, r.transitions);
  const primary = entries.find((entry) => entry.to === primaryTo);
  const closeForcing = () => {
    setForcing(null);
    setReason('');
    force.reset();
  };
  const primaryButton = primary ? (
    <Button size="sm" data-emphasis="primary" disabled={!primary.enabled || move.isPending} onClick={() => move.mutate({ to: primary.to })}>
      {primary.label}
    </Button>
  ) : null;

  return (
    <section className="rounded-md border bg-card px-3 py-2" aria-labelledby="status-title">
      <h2 id="status-title" className="sr-only">
        状态
      </h2>
      <div className="flex items-center gap-2">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium" data-testid="current-state">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: state?.color }} aria-hidden="true" />
          <span className="truncate">{state?.label ?? r.stateKey}</span>
        </p>
        {primaryButton &&
          (primary?.enabled ? (
            primaryButton
          ) : (
            <DisabledReason disabled reason={primary?.reason}>
              {primaryButton}
            </DisabledReason>
          ))}
        {entries.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="outline" disabled={move.isPending}>
                变更状态
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="可流转到" className="w-72">
              {entries.map((entry) => {
                const source = r.transitions.find((t) => t.to === entry.to);
                const forceable = !!source && !source.allowed && r.canForce && canEdit;
                return (
                  <Fragment key={entry.to}>
                    <DropdownMenuItem
                      aria-disabled={entry.enabled ? undefined : true}
                      className={entry.reason ? 'flex-col items-start gap-0.5 whitespace-normal' : undefined}
                      onSelect={(event) => {
                        if (!entry.enabled || move.isPending) {
                          event.preventDefault();
                          return;
                        }
                        move.mutate({ to: entry.to });
                      }}
                    >
                      <span>{entry.label}</span>
                      {entry.reason && <span className="text-xs leading-4 font-normal text-muted-foreground">{entry.reason}</span>}
                    </DropdownMenuItem>
                    {forceable && (
                      <DropdownMenuItem className="text-xs text-muted-foreground" onSelect={() => setForcing({ to: entry.to, label: entry.label })}>
                        强制流转到「{entry.label}」
                      </DropdownMenuItem>
                    )}
                  </Fragment>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
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
