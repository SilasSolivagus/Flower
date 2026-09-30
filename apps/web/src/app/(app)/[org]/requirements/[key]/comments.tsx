'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { qk, useApiMutation, useRequirementComments } from '@/lib/queries';

export function Comments({ org, requirementId }: { org: string; requirementId: string }) {
  const comments = useRequirementComments(org, requirementId);
  const [body, setBody] = useState('');
  const add = useApiMutation(() => api(`/orgs/${org}/requirements/${requirementId}/comments`, { method: 'POST', body: { body } }), {
    invalidate: [qk.requirementComments(org, requirementId)],
    onSuccess: () => setBody(''),
  });
  const read = useApiMutation(() => api(`/orgs/${org}/requirements/${requirementId}/comments/read`, { method: 'POST' }), {
    invalidate: [qk.requirementComments(org, requirementId), qk.workbench],
    silentError: true,
  });
  const readMutate = read.mutate;
  useEffect(() => {
    readMutate(undefined);
  }, [requirementId, readMutate]);

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="comments-title">
      <h2 id="comments-title" className="mb-3 text-sm font-semibold">
        评论 <span className="font-mono text-xs text-muted-foreground">{comments.data?.length ?? 0}</span>
      </h2>
      <ul className="flex flex-col gap-3">
        {(comments.data ?? []).map((c) => (
          <li key={c.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">{c.author?.displayName ?? '未知成员'}</span>
              <span>{formatDateTime(c.createdAt)}</span>
              {c.kind === 'update' && <Badge variant="outline">进展</Badge>}
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-6">{c.body}</p>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined);
        }}
      >
        <Textarea aria-label="写评论" placeholder="写评论…" value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!body.trim() || add.isPending}>
            发表
          </Button>
        </div>
      </form>
    </section>
  );
}
