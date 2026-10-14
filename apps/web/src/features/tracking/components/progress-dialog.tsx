'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import type { ProgressTarget } from '@/features/tracking/model';
import { api } from '@/lib/api';
import { qk, requirementKeys, trackingKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { ProgressEntry } from '@/lib/types';

function ProgressForm({ org, target, defaultFollower, onDone }: { org: string; target: ProgressTarget; defaultFollower: string | null; onDone: (follower: string | null) => void }) {
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [body, setBody] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [follower, setFollower] = useState<string | null>(defaultFollower);
  const [expected, setExpected] = useState(target.expectedDate ?? '');
  const base = target.type === 'requirement' ? 'requirements' : 'work-items';
  const dateChanged = target.canEditDate && expected !== (target.expectedDate ?? '');
  const save = useApiMutation(
    () =>
      api<{ progress: ProgressEntry }>(`/orgs/${org}/${base}/${target.id}/progress`, {
        method: 'POST',
        body: { body: body.trim(), nextStep: nextStep.trim() || null, followerMemberId: follower, ...(dateChanged ? { expectedDate: expected || null } : {}) },
      }),
    { invalidate: [trackingKeys(org), requirementKeys(org), qk.workbench], silentError: true, success: '已记录进展', onSuccess: () => onDone(follower) },
  );
  const people = activePeople(members.data ?? []);
  const dateLabel = target.type === 'requirement' ? '预计上线日期' : '预计完成日期';

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="progress-body">进展</Label>
        <Textarea id="progress-body" autoFocus maxLength={2000} className="min-h-24 text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="progress-next">下一步</Label>
        <Input id="progress-next" maxLength={500} value={nextStep} onChange={(e) => setNextStep(e.target.value)} />
      </div>
      {people.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>跟进人</Label>
          <MemberPicker label="跟进人" className="w-full" noneLabel="不指定" options={pickerOptions(people, null)} value={follower} onChange={setFollower} modal />
        </div>
      )}
      {target.canEditDate && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="progress-date">{dateLabel}</Label>
          <Input id="progress-date" type="date" className="w-44" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      )}
      <FormError error={save.error} />
      <DialogFooter>
        <Button type="submit" disabled={!body.trim() || save.isPending}>
          保存
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * 写进展的小窗：进展、下一步、跟进人，可以顺手改预计日期。
 * 连续填写时由调用方把上一次选择的跟进人传回 defaultFollower；每次打开都重新挂载表单，进展与下一步从空开始。
 */
export function WriteProgressDialog({
  org,
  target,
  defaultFollower,
  onOpenChange,
  onSaved,
}: {
  org: string;
  target: ProgressTarget | null;
  defaultFollower: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (follower: string | null) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>写进展</DialogTitle>
          <DialogDescription>{target ? `${target.displayKey} ${target.title}` : ''}</DialogDescription>
        </DialogHeader>
        {target && (
          <ProgressForm
            key={target.id}
            org={org}
            target={target}
            defaultFollower={defaultFollower}
            onDone={(follower) => {
              onSaved(follower);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
