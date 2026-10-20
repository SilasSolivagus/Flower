'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { NO_PERMISSION_MESSAGE, NoAccess } from '@/components/no-access';
import { isOrgAdminRole } from '@/features/shell/nav';
import { useOrg } from '@/lib/queries';

export default function SettingsIndexPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const q = useOrg(org);
  const admin = q.data ? isOrgAdminRole(q.data.me.orgRole) : false;
  useEffect(() => {
    if (admin) router.replace(`/${org}/settings/members`);
  }, [admin, org, router]);
  if (!q.data || admin) return null;
  return <NoAccess message={NO_PERMISSION_MESSAGE} />;
}
