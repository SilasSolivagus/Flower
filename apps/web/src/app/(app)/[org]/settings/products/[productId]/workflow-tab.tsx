'use client';

import Link from 'next/link';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { CATEGORY_COLOR } from '@/lib/labels';
import { qk, useApiMutation, useProductWorkflow, useWorkflows } from '@/lib/queries';

export function WorkflowTab({ org, productId, isOrgAdmin }: { org: string; productId: string; isOrgAdmin: boolean }) {
  const pw = useProductWorkflow(org, productId);
  const templates = useWorkflows(org, isOrgAdmin);
  const inv = { invalidate: [qk.productWorkflow(org, productId), qk.workflows(org)] };
  const use = useApiMutation((versionId: string) => api(`/orgs/${org}/products/${productId}/workflow`, { method: 'PUT', body: { versionId } }), {
    ...inv,
    success: '已切换流程',
  });
  const fork = useApiMutation(
    () => api(`/orgs/${org}/products/${productId}/workflow/fork`, { method: 'POST', body: { fromVersionId: pw.data!.version.id } }),
    { ...inv, success: '已复制为本产品的流程' },
  );
  if (!pw.data) return null;
  const { definition, version } = pw.data;
  const own = definition.productId === productId;
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{definition.name}</span>
          <span className="rounded-sm bg-muted px-1.5 font-mono text-xs">v{version.version}</span>
          <span className="text-xs text-muted-foreground">{own ? '本产品专用' : '组织流程模板'}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {version.body.states.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs">
              <span className="size-2 rounded-[2px]" style={{ background: CATEGORY_COLOR[s.category] }} />
              {s.label}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          {own && (
            <Button asChild variant="outline">
              <Link href={`/${org}/settings/workflows/${definition.id}`}>编辑本产品的流程</Link>
            </Button>
          )}
          {!own && (
            <ConfirmAction
              trigger={<Button variant="outline">复制为本产品的流程</Button>}
              title="复制为本产品的流程？"
              description="复制后，本产品使用自己的流程副本，组织模板的后续修改不再影响本产品。"
              confirmLabel="确认复制"
              onConfirm={() => fork.mutate(undefined)}
            />
          )}
        </div>
      </section>
      {isOrgAdmin && templates.data && (
        <section className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <span className="text-sm">改用组织模板</span>
          <Select onValueChange={(v) => use.mutate(v)}>
            <SelectTrigger className="w-72" aria-label="改用组织模板">
              <SelectValue placeholder="选择模板的当前版本" />
            </SelectTrigger>
            <SelectContent>
              {templates.data
                .filter((t) => t.productId === null && !t.archivedAt && t.currentVersionId)
                .map((t) => (
                  <SelectItem key={t.id} value={t.currentVersionId!}>
                    {t.name} · v{t.currentVersion}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </section>
      )}
    </div>
  );
}
