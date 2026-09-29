'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CreateOrgDialog } from '@/components/create-org-dialog';
import { PlainShell } from '@/components/plain-shell';
import { Button } from '@/components/ui/button';
import { ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { useMe, useSetupStatus } from '@/lib/queries';

export default function HomePage() {
  const router = useRouter();
  const me = useMe();
  const setup = useSetupStatus();
  const [creating, setCreating] = useState(false);
  const orgs = me.data?.orgs ?? [];
  const canCreate = Boolean(me.data?.account.isInstanceAdmin || setup.data?.allowOrgCreation);

  useEffect(() => {
    if (orgs.length === 1) router.replace(`/${orgs[0]!.slug}`);
  }, [orgs, router]);

  return (
    <PlainShell>
      <div className="flex items-end justify-between">
        <h1 className="text-xl font-semibold">我的组织</h1>
        {canCreate && <Button onClick={() => setCreating(true)}>新建组织</Button>}
      </div>
      {orgs.length === 0 ? (
        <p className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
          你还没有加入任何组织。{canCreate ? '可以新建一个组织，或' : ''}请向组织管理员索取邀请链接。
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-4">
          {orgs.map((o) => (
            <li key={o.id}>
              <Link href={`/${o.slug}`} className="flex flex-col gap-3 rounded-lg border bg-card p-4 hover:border-primary">
                <span className="flex items-center justify-between">
                  <span className="font-semibold">{o.name}</span>
                  <span className="text-xs text-muted-foreground">{ORG_ROLE_LABEL[o.role]}</span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {o.products.map((p) => (
                    <span key={p.id} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                      <span className="font-mono">{p.key}</span> {p.name} · {PRODUCT_ROLE_LABEL[p.role]}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </PlainShell>
  );
}
