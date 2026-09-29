'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { iterationKeys, requirementKeys, useApiMutation } from '@/lib/queries';

export type ForceJoinTarget = { requirementId: string; requirementLabel: string; iterationId: string; iterationName: string; unmet: string[] };

/** 产品管理员跳过加入迭代的准入条件；原因写入审计事件。 */
export function ForceJoinDialog({ org, target, onClose }: { org: string; target: ForceJoinTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const force = useApiMutation(
    (t: ForceJoinTarget) => api(`/orgs/${org}/requirements/${t.requirementId}/iteration`, { method: 'PUT', body: { iterationId: t.iterationId, force: true, reason } }),
    {
      invalidate: [iterationKeys(org), requirementKeys(org)],
      silentError: true,
      success: '已强制加入迭代',
      onSuccess: () => {
        setReason('');
        onClose();
      },
    },
  );
  const close = () => {
    setReason('');
    force.reset();
    onClose();
  };
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>强制加入「{target?.iterationName}」</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-muted-foreground">{target?.requirementLabel} 未满足加入迭代的条件：</p>
        <ul className="pl-1 text-[13px] text-muted-foreground">
          {target?.unmet.map((m, i) => (
            <li key={i}>· {m}</li>
          ))}
        </ul>
        <p className="text-[13px] text-muted-foreground">强制加入会跳过这些条件，原因会记入审计记录。</p>
        <Textarea aria-label="原因" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        <FormError error={force.error} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button disabled={!reason.trim() || force.isPending} onClick={() => target && force.mutate(target)}>
            确认加入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
