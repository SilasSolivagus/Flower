'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { TemplateEditor } from '@/components/template-editor';

export default function TemplatesPage() {
  const { org } = useParams<{ org: string }>();
  return (
    <RequireOrgAdmin>
      <PageHeader crumbs={[{ label: '组织设置' }, { label: '文档模板' }]} title="文档模板" description="新建 PRD 时套用；提交评审时检查必填小节。" />
      <TemplateEditor org={org} productId={null} />
    </RequireOrgAdmin>
  );
}
