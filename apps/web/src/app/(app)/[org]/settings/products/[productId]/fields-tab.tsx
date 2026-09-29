'use client';

import { LevelNamesEditor } from '@/components/level-names-editor';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useLevelNames } from '@/lib/queries';

export function FieldsTab({ org, productId }: { org: string; productId: string }) {
  const fields = useFields(org, productId);
  const levels = useLevelNames(org, productId);
  const inv = [qk.fields(org, productId)];
  const fork = useApiMutation((fieldId: string) => api(`/orgs/${org}/products/${productId}/fields/${fieldId}/fork`, { method: 'POST' }), {
    invalidate: inv,
    success: '已为本产品覆盖该字段',
  });
  const saveLevels = useApiMutation(
    (names: string[] | null) => api(`/orgs/${org}/products/${productId}/level-names`, { method: 'PUT', body: { names } }),
    { invalidate: [qk.levels(org, productId)], success: '已保存' },
  );
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border bg-card">
        <h2 className="border-b px-4 py-3 font-semibold">字段</h2>
        <ul className="divide-y">
          {fields.data?.map((f) => (
            <li key={f.id} className="flex h-10 items-center gap-3 px-4">
              <span className="w-24 font-medium">{f.label}</span>
              <span className="flex-1 truncate text-[13px] text-muted-foreground">
                {f.options.filter((o) => o.active).map((o) => o.label).join('、') || '暂无选项'}
              </span>
              {f.productId ? (
                <span className="text-xs text-primary">产品覆盖</span>
              ) : (
                <Button variant="ghost" size="sm" aria-label={`覆盖 ${f.label}`} onClick={() => fork.mutate(f.id)}>
                  为本产品覆盖
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">覆盖后，本产品的选项在「字段字典」页面单独维护，与组织字段互不影响。</p>
      </section>
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 className="font-semibold">结构树层级叫法</h2>
        {levels.data && (
          <LevelNamesEditor
            value={levels.data.names}
            saving={saveLevels.isPending}
            onSave={(names) => saveLevels.mutate(names)}
            onClear={levels.data.source === 'product' ? () => saveLevels.mutate(null) : undefined}
          />
        )}
      </section>
    </div>
  );
}
