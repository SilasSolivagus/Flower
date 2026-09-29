'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { useOrg } from '@/lib/queries';

export default function OrgOverviewPage() {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  return <PageHeader title={q.data?.org.name ?? ''} description="组织概览" />;
}
