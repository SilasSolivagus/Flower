'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { OptionMultiSelect } from '@/components/option-multi-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { api } from '@/lib/api';
import { requirementKeys, useApiMutation, useFields, useMembers, useOrg } from '@/lib/queries';
import type { RequirementListItem } from '@/lib/types';

const NONE = '__none';

export function CreateRequirementDialog({ org, productId, open, onOpenChange }: { org: string; productId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const fields = useFields(org, productId);
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [title, setTitle] = useState('');
  const [requester, setRequester] = useState<string | null>(null);
  const [priority, setPriority] = useState(NONE);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const reset = () => {
    setTitle('');
    setRequester(null);
    setPriority(NONE);
    setPlatforms([]);
  };
  const create = useApiMutation(
    () =>
      api<{ requirement: RequirementListItem }>(`/orgs/${org}/products/${productId}/requirements`, {
        method: 'POST',
        body: {
          title,
          requesterMemberId: requester,
          fields: { ...(priority !== NONE && { priority: [priority] }), ...(platforms.length > 0 && { platform: platforms }) },
        },
      }),
    {
      invalidate: [requirementKeys(org)],
      silentError: true,
      onSuccess: (d) => {
        toast.success(`已创建 ${d.requirement.displayKey}`);
        reset();
        onOpenChange(false);
      },
    },
  );
  const priorityField = fields.data?.find((f) => f.key === 'priority');
  const platformField = fields.data?.find((f) => f.key === 'platform');
  const people = activePeople(members.data ?? []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建需求</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="req-title">标题</Label>
            <Input id="req-title" value={title} maxLength={200} autoFocus onChange={(e) => setTitle(e.target.value)} />
          </div>
          {people.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>提出人</Label>
              <MemberPicker label="提出人" className="w-full" noneLabel="不填" options={pickerOptions(people, null)} value={requester} onChange={setRequester} modal />
            </div>
          )}
          <div className="flex gap-4">
            {priorityField && (
              <div className="flex flex-col gap-1.5">
                <Label>优先级</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger className="w-32" aria-label="优先级">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>不填</SelectItem>
                    {priorityField.options
                      .filter((o) => o.active)
                      .map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {platformField && platformField.options.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>平台</Label>
                <OptionMultiSelect label="选择平台" options={platformField.options.filter((o) => o.active).map((o) => ({ id: o.id, label: o.label }))} value={platforms} onChange={setPlatforms} />
              </div>
            )}
          </div>
          <FormError error={create.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
