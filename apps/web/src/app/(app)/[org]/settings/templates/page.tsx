'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { TemplateEditor } from '@/components/template-editor';

export default function TemplatesPage() {
  const { org } = useParams<{ org: string }>();
  return (
    <RequireOrgAdmin>
      <PageHeader crumbs={[{ label: '组织设置' }, { label: '文档模板' }]} title="文档模板" description="新建 PRD 与简报时套用；PRD 提交评审时检查必填小节，简报的必填小节用于「写 PRD 前检查」。" />
      <TemplateEditor org={org} productId={null} />
    </RequireOrgAdmin>
  );
}
