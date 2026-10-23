'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { canListMembers } from '@/features/members/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFunctionTags, useMe, useMembers, useOrg } from '@/lib/queries';
import type { Account, MyOrg } from '@/lib/types';
import { parseWorkbenchPersona, PERSONA_OPTIONS, personaInputsReady, resolvePersona, tagNamesForMember, type PersonaSource, type WorkbenchPersona } from './persona';

export function useWorkbenchPersona(org: string) {
  const params = useSearchParams();
  const me = useMe();
  const orgQ = useOrg(org);
  const canReadTags = canListMembers(orgQ.data?.me);
  const members = useMembers(org, canReadTags);
  const tags = useFunctionTags(org, canReadTags);
  const [override, setOverride] = useState<WorkbenchPersona | null>(null);
  const stored = me.data?.account.preferences.workbenchPersona;
  const storedPreference = typeof stored === 'string' || stored === null ? stored : null;
  const ready = personaInputsReady({
    urlPersona: params.get('persona'),
    meLoaded: me.isFetched,
    preference: storedPreference,
    orgLoaded: orgQ.isFetched,
    canReadTags,
    tagsLoaded: (members.isSuccess || members.isError) && (tags.isSuccess || tags.isError),
  });
  const resolved = resolvePersona({
    urlPersona: override ? null : params.get('persona'),
    preference: override ?? storedPreference,
    tagNames: tagNamesForMember(orgQ.data?.me.memberId, members.data, tags.data),
  });
  return { ready, resolved, setOverride };
}

export function PersonaSwitch({
  ready,
  resolved,
  setOverride,
}: {
  ready: boolean;
  resolved: { persona: WorkbenchPersona; source: PersonaSource };
  setOverride: (persona: WorkbenchPersona | null) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const save = useApiMutation(
    async (persona: WorkbenchPersona) => {
      const data = await api<{ account: Account }>('/me', { method: 'PATCH', body: { preferences: { workbenchPersona: persona } } });
      qc.setQueryData(qk.me, (old: { account: Account; orgs: MyOrg[] } | undefined) => (old ? { ...old, account: data.account } : old));
      return data;
    },
    { invalidate: [qk.me] },
  );
  const preview = ready && resolved.source === 'url';

  return (
    <div className="flex items-center gap-1.5" data-preview={preview ? 'true' : 'false'}>
      <label htmlFor="workbench-persona" className="flex items-center gap-1 text-[13px] text-foreground">
        <span>以</span>
        <select
          id="workbench-persona"
          aria-label="以视角查看"
          disabled={!ready || save.isPending}
          value={ready ? resolved.persona : ''}
          className="h-8 rounded-md border bg-card px-2 text-[13px]"
          onChange={(event) => {
            const next = parseWorkbenchPersona(event.target.value);
            if (!next) return;
            const previousUrl = params.get('persona');
            setOverride(next);
            const query = new URLSearchParams(params.toString());
            query.delete('persona');
            const search = query.toString();
            router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
            save.mutate(next, {
              onSuccess: () => setOverride(null),
              onError: () => {
                setOverride(null);
                if (!previousUrl) return;
                const back = new URLSearchParams(params.toString());
                back.set('persona', previousUrl);
                const restored = back.toString();
                router.replace(restored ? `${pathname}?${restored}` : pathname, { scroll: false });
              },
            });
          }}
        >
          {ready ? null : <option value="">加载中</option>}
          {PERSONA_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span>视角</span>
      </label>
      {preview ? <span className="text-xs text-muted-foreground">预览</span> : null}
    </div>
  );
}
