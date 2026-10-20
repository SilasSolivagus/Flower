'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { isOrgAdminRole } from '@/features/shell/nav';
import { useOrg } from '@/lib/queries';
import { NO_PERMISSION_MESSAGE, NoAccess } from './no-access';

export function RequireOrgAdmin({ children }: { children: ReactNode }) {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  if (!q.data) return null;
  return isOrgAdminRole(q.data.me.orgRole) ? <>{children}</> : <NoAccess message={NO_PERMISSION_MESSAGE} />;
}
