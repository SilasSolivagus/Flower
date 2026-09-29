'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { suggestSlug } from '@/features/orgs/slug';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Org } from '@/lib/types';
import { FormError } from './form-error';

export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const m = useApiMutation((v: { name: string; slug: string }) => api<{ org: Org }>('/orgs', { method: 'POST', body: v }), {
    invalidate: [qk.me],
    success: '组织已创建',
    silentError: true,
    onSuccess: (d) => {
      onOpenChange(false);
      router.push(`/${d.org.slug}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({ name, slug });
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>新建组织</DialogTitle>
            <DialogDescription>组织标识会出现在网址中，创建后不能修改。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-org-name">组织名称</Label>
            <Input
              id="new-org-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(suggestSlug(e.target.value));
              }}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-org-slug">组织标识</Label>
            <Input
              id="new-org-slug"
              className="font-mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="例如 pan"
              required
            />
          </div>
          <FormError error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={m.isPending}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
