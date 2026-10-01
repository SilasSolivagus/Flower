'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { linkCandidates } from '@/features/iterations/model';
import { api } from '@/lib/api';
import { releaseKeys, requirementKeys, useApiMutation } from '@/lib/queries';
import type { IterationDetail, Release } from '@/lib/types';

/** 从本迭代的需求里勾选多条，一次关联到发布版本；已关联的显示为勾选且不能再改。打开另一个版本时由父组件换 key 重置勾选。 */
export function LinkRequirementsDialog({ org, iteration, release, onClose }: { org: string; iteration: IterationDetail; release: Release | null; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const allCandidates = release ? linkCandidates(iteration.requirements, release, '') : [];
  const candidates = release ? linkCandidates(iteration.requirements, release, query) : [];
  const link = useApiMutation(
    () => api<{ linked: number }>(`/orgs/${org}/releases/${release!.id}/requirements`, { method: 'POST', body: { requirementIds: picked } }),
    { invalidate: [releaseKeys(org), requirementKeys(org)], silentError: true, success: '已关联需求', onSuccess: onClose },
  );
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Dialog open={!!release} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>关联需求到 {release?.versionName}</DialogTitle>
        </DialogHeader>
        <Input aria-label="筛选需求" placeholder="输入编号或标题" value={query} onChange={(e) => setQuery(e.target.value)} />
        {candidates.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            {allCandidates.length === 0 ? '本迭代里没有这个产品的需求' : '没有匹配的需求'}
          </p>
        ) : (
          <ul aria-label="本迭代的需求" className="flex max-h-80 flex-col overflow-y-auto">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="flex h-8 items-center gap-2 rounded-sm px-2 text-[13px] hover:bg-muted">
                  <Checkbox
                    aria-label={`${c.displayKey} ${c.title}`}
                    checked={c.linked || picked.includes(c.id)}
                    disabled={c.linked}
                    onCheckedChange={() => toggle(c.id)}
                  />
                  <span className="font-mono text-muted-foreground">{c.displayKey}</span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.linked && <span className="text-xs text-muted-foreground">已关联</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        <FormError error={link.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={picked.length === 0 || link.isPending} onClick={() => link.mutate(undefined)}>
            关联所选（<span className="font-mono">{picked.length}</span>）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
