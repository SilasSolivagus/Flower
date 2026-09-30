'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CreateOrgDialog } from '@/components/create-org-dialog';
import { PlainShell } from '@/components/plain-shell';
import { Button } from '@/components/ui/button';
import { useMe, useSetupStatus } from '@/lib/queries';

export default function HomePage() {
  const router = useRouter();
  const me = useMe();
  const setup = useSetupStatus();
  const [creating, setCreating] = useState(false);
  const canCreate = Boolean(me.data?.account.isInstanceAdmin || setup.data?.allowOrgCreation);
  const firstSlug = me.data?.orgs[0]?.slug ?? null;

  useEffect(() => {
    if (firstSlug) router.replace(`/${firstSlug}`);
  }, [firstSlug, router]);

  if (firstSlug) return null;
  return (
    <PlainShell>
      <div className="flex items-end justify-between">
        <h1 className="text-xl font-semibold">我的组织</h1>
        {canCreate && <Button onClick={() => setCreating(true)}>新建组织</Button>}
      </div>
      <p className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        你还没有加入任何组织。{canCreate ? '可以新建一个组织，或' : ''}请向组织管理员索取邀请链接。
      </p>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </PlainShell>
  );
}
