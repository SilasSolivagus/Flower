'use client';

import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ORG_ROLE_LABEL } from '@/lib/labels';
import { useMe, useSetupStatus } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { CreateOrgDialog } from './create-org-dialog';

export function OrgSwitcher({ current, rail = false }: { current: string; rail?: boolean }) {
  const router = useRouter();
  const me = useMe();
  const setup = useSetupStatus();
  const [creating, setCreating] = useState(false);
  const orgs = me.data?.orgs ?? [];
  const active = orgs.find((o) => o.slug === current);
  const canCreate = Boolean(me.data?.account.isInstanceAdmin || setup.data?.allowOrgCreation);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title={active?.name ?? current}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
            rail && 'xl:justify-center xl:px-0',
          )}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            {(active?.name ?? current).slice(0, 1)}
          </span>
          <span className={cn('flex min-w-0 flex-1 flex-col', rail && 'xl:sr-only')}>
            <span className="truncate font-semibold">{active?.name ?? current}</span>
            <span className="text-xs text-muted-foreground">{active ? ORG_ROLE_LABEL[active.role] : ''}</span>
          </span>
          <ChevronsUpDown className={cn('size-4 text-muted-foreground', rail && 'xl:hidden')} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>我加入的组织</DropdownMenuLabel>
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => router.push(`/${o.slug}`)}>
              <span className="flex-1 truncate">{o.name}</span>
              {o.slug === current && <Check className="size-4" aria-hidden="true" />}
            </DropdownMenuItem>
          ))}
          {canCreate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <Plus className="size-4" aria-hidden="true" />
                新建组织
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
