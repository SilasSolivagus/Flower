'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FieldCard } from '@/components/field-card';
import { LevelNamesEditor } from '@/components/level-names-editor';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useLevelNames, useProducts } from '@/lib/queries';

function FieldsPage() {
  const { org } = useParams<{ org: string }>();
  const products = useProducts(org);
  const [scope, setScope] = useState<string>('org');
  const productId = scope === 'org' ? undefined : scope;
  const fields = useFields(org, productId);
  const levels = useLevelNames(org);
  const saveLevels = useApiMutation((names: string[]) => api(`/orgs/${org}/level-names`, { method: 'PUT', body: { names } }), {
    invalidate: [qk.levels(org)],
    success: '已保存',
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '字段字典' }]}
        title="字段字典"
        description="字典实时生效。产品可以覆盖某个字段，之后独立维护自己的选项。"
        actions={
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="w-48" aria-label="查看范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="org">组织字段</SelectItem>
              {products.data?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  产品：{p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="grid grid-cols-2 gap-4">
        {fields.data?.map((f) => (
          <FieldCard key={f.id} org={org} field={f} productId={productId} editable={scope === 'org' ? f.productId === null : f.productId !== null} />
        ))}
      </div>
      {scope === 'org' && (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h2 className="font-semibold">结构树层级叫法</h2>
          {levels.data && <LevelNamesEditor value={levels.data.names} saving={saveLevels.isPending} onSave={(names) => saveLevels.mutate(names)} />}
        </section>
      )}
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <FieldsPage />
    </RequireOrgAdmin>
  );
}
