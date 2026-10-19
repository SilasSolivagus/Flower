'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { invalidRequirementKeys, parseRequirementKeys } from '@/features/documents/model';
import { ApiError, api } from '@/lib/api';
import { useApiMutation } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 文档覆盖的需求：列表、按编号关联、移出。变更 PRD 与简报共用，服务端按文档类型写对应的列。 */
export function CoveredRequirements({ org, doc, invalidate }: { org: string; doc: DocumentDetail; invalidate: ReadonlyArray<readonly unknown[]> }) {
  const canEdit = doc.myRole !== 'viewer';
  const [keys, setKeys] = useState('');
  const link = useApiMutation(
    async (input: string) => {
      const bad = invalidRequirementKeys(input);
      if (bad.length > 0) throw new ApiError(400, 'invalid', `无法识别的需求编号：${bad.join('、')}（应为 ${doc.productKey}-12 这样的写法）`, null);
      const wanted = parseRequirementKeys(input);
      if (wanted.length === 0) throw new ApiError(400, 'invalid', '请输入需求编号，例如 PAN-12', null);
      const ids = await Promise.all(wanted.map(async (k) => (await api<{ requirement: { id: string } }>(`/orgs/${org}/requirements/${encodeURIComponent(k)}`)).requirement.id));
      return api(`/orgs/${org}/documents/${doc.id}/requirements`, { method: 'POST', body: { requirementIds: ids } });
    },
    { silentError: true, invalidate, success: '已关联需求', onSuccess: () => setKeys('') },
  );
  const unlink = useApiMutation((requirementId: string) => api(`/orgs/${org}/documents/${doc.id}/requirements/${requirementId}`, { method: 'DELETE' }), {
    invalidate,
    success: '已移出',
  });
  const linkedTitle = doc.kind === 'brief' ? '关联的需求' : '覆盖的需求';
  const linkedEmpty = doc.kind === 'brief' ? '还没有关联需求' : '还没有覆盖需求';
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-req-title">
      <h2 id="doc-req-title" className="mb-2 text-sm font-semibold">
        {linkedTitle}
      </h2>
      {doc.requirements.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{linkedEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {doc.requirements.map((r) => (
            <li key={r.id} className="flex h-8 items-center gap-2 text-[13px]">
              <Link href={`/${org}/requirements/${r.displayKey}`} className="min-w-0 flex-1 truncate hover:underline">
                <span className="mr-2 font-mono text-muted-foreground">{r.displayKey}</span>
                {r.title}
              </Link>
              {canEdit && (
                <Button size="icon-sm" variant="ghost" aria-label={`移出 ${r.displayKey}`} disabled={unlink.isPending} onClick={() => unlink.mutate(r.id)}>
                  <X className="size-4" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && doc.status !== 'discarded' && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            link.mutate(keys);
          }}
        >
          <div className="flex gap-2">
            <Input aria-label="需求编号" placeholder={`${doc.productKey}-12, ${doc.productKey}-15`} className="h-8" value={keys} onChange={(e) => setKeys(e.target.value)} />
            <Button type="submit" size="sm" disabled={link.isPending || !keys.trim()}>
              关联
            </Button>
          </div>
          <FormError error={link.error} />
        </form>
      )}
    </section>
  );
}
