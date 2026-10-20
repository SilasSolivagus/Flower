'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { isOrgAdminRole } from '@/features/shell/nav';
import { SettingsSubnav } from '@/features/shell/settings-subnav';
import { useOrg } from '@/lib/queries';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  const admin = q.data ? isOrgAdminRole(q.data.me.orgRole) : false;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {admin && <SettingsSubnav org={org} />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
