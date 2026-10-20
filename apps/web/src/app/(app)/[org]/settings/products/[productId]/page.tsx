'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { NO_PERMISSION_MESSAGE, NoAccess } from '@/components/no-access';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TemplateEditor } from '@/components/template-editor';
import { isOrgAdminRole } from '@/features/shell/nav';
import { api } from '@/lib/api';
import { qk, useApiMutation, useOrg, useProduct } from '@/lib/queries';
import { FieldsTab } from './fields-tab';
import { NotificationsTab } from './notifications-tab';
import { RolesTab } from './roles-tab';
import { StructureTab } from './structure-tab';
import { WorkflowTab } from './workflow-tab';

export default function ProductDetailPage() {
  const { org, productId } = useParams<{ org: string; productId: string }>();
  const orgQ = useOrg(org);
  const product = useProduct(org, productId);
  const [name, setName] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const serverName = product.data?.name ?? '';
  const [syncedName, setSyncedName] = useState('');
  if (serverName !== syncedName) {
    setSyncedName(serverName);
    setName(serverName);
  }
  const update = useApiMutation(
    (body: { name?: string; status?: 'active' | 'archived' }) => api(`/orgs/${org}/products/${productId}`, { method: 'PATCH', body }),
    { invalidate: [qk.product(org, productId), qk.products(org), qk.me], success: '已保存' },
  );
  if (!product.data && product.isError) {
    return <QueryError error={product.error} noAccessMessage={NO_PERMISSION_MESSAGE} retryMessage="加载产品失败，请重试。" onRetry={() => product.refetch()} />;
  }
  if (!product.data || !orgQ.data) return null;
  if (product.data.myRole !== 'admin') return <NoAccess message={NO_PERMISSION_MESSAGE} />;
  const p = product.data;
  const orgAdmin = isOrgAdminRole(orgQ.data.me.orgRole);
  return (
    <>
      <PageHeader
        crumbs={
          orgAdmin
            ? [{ label: '组织设置' }, { label: '产品', href: `/${org}/settings/products` }, { label: p.name }]
            : [{ label: '概览', href: `/${org}/overview` }, { label: '产品设置' }, { label: p.name }]
        }
        title={p.name}
        description={
          <>
            编号前缀 <span className="font-mono">{p.key}</span>
            {p.status === 'archived' && ' · 已归档'}
          </>
        }
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">概况</TabsTrigger>
          <TabsTrigger value="roles">成员角色</TabsTrigger>
          <TabsTrigger value="workflow">流程</TabsTrigger>
          <TabsTrigger value="fields">字段与层级</TabsTrigger>
          <TabsTrigger value="structure">结构树</TabsTrigger>
          <TabsTrigger value="templates">文档模板</TabsTrigger>
          <TabsTrigger value="notifications">推送</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <section className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-name">产品名称</Label>
              <div className="flex gap-2">
                <Input id="pd-name" value={name} onChange={(e) => setName(e.target.value)} />
                <Button onClick={() => update.mutate({ name })} disabled={update.isPending || name === p.name}>
                  保存
                </Button>
              </div>
            </div>
            <div className="flex flex-col items-start gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-prose text-[13px] leading-6 text-muted-foreground">归档后产品不再出现在日常视图中，数据保留。</p>
              <Button variant="outline" className="shrink-0" onClick={() => setConfirmArchive(true)}>
                {p.status === 'active' ? '归档产品' : '取消归档'}
              </Button>
            </div>
            <ConfirmDialog
              open={confirmArchive}
              title={p.status === 'active' ? '归档产品' : '取消归档'}
              description={p.status === 'active' ? '归档后产品不再出现在日常视图中，数据保留。确认后才会归档。' : '取消归档后，产品会重新出现在日常视图中。确认后才会生效。'}
              confirmLabel={p.status === 'active' ? '确认归档' : '确认取消归档'}
              onCancel={() => setConfirmArchive(false)}
              onConfirm={() => {
                setConfirmArchive(false);
                update.mutate({ status: p.status === 'active' ? 'archived' : 'active' });
              }}
            />
          </section>
        </TabsContent>
        <TabsContent value="roles">
          <RolesTab org={org} productId={productId} />
        </TabsContent>
        <TabsContent value="workflow">
          <WorkflowTab org={org} productId={productId} isOrgAdmin={orgAdmin} />
        </TabsContent>
        <TabsContent value="fields">
          <FieldsTab org={org} productId={productId} />
        </TabsContent>
        <TabsContent value="structure">
          <StructureTab org={org} productId={productId} />
        </TabsContent>
        <TabsContent value="templates">
          <TemplateEditor org={org} productId={productId} />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationsTab org={org} productId={productId} />
        </TabsContent>
      </Tabs>
    </>
  );
}
