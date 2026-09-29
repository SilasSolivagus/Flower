'use client';

import { validateWorkflowBody } from '@flower/core/workflow-schema';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ActionGate } from '@/features/workflow/components/action-gate';
import { CheckItems } from '@/features/workflow/components/check-items';
import { ConditionSheet } from '@/features/workflow/components/condition-sheet';
import { FlowPreview } from '@/features/workflow/components/flow-preview';
import { PublishDialog } from '@/features/workflow/components/publish-dialog';
import { StatesTable } from '@/features/workflow/components/states-table';
import { TransitionMatrix } from '@/features/workflow/components/transition-matrix';
import { ValidationPanel } from '@/features/workflow/components/validation-panel';
import { VersionHistory } from '@/features/workflow/components/version-history';
import { toggleTransition, transitionMode } from '@/features/workflow/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useFunctionTags, useMembers, useWorkflow } from '@/lib/queries';
import type { WorkflowBody, WorkflowVersion } from '@/lib/types';

export default function WorkflowEditorPage() {
  const { org, id } = useParams<{ org: string; id: string }>();
  const wf = useWorkflow(org, id);
  const productId = wf.data?.definition.productId ?? undefined;
  const fields = useFields(org, productId);
  const tags = useFunctionTags(org);
  const members = useMembers(org);
  const [draft, setDraft] = useState<WorkflowBody | null>(null);
  const [selected, setSelected] = useState<{ from: string; to: string } | null>(null);
  const current = wf.data?.versions[0];

  if (current && !draft) setDraft(current.body);

  const issues = useMemo(() => {
    if (!draft || !fields.data) return [];
    const r = validateWorkflowBody(draft, { fieldKeys: fields.data.map((f) => f.key) });
    return r.ok ? [] : r.issues;
  }, [draft, fields.data]);

  const publish = useApiMutation(
    (note: string) => api<{ version: WorkflowVersion }>(`/orgs/${org}/workflows/${id}/versions`, { method: 'POST', body: { body: draft, note } }),
    {
      invalidate: [qk.workflow(org, id), qk.workflows(org)],
      silentError: true,
      onSuccess: (d) => {
        toast.success(`已发布 v${d.version.version}`);
        setDraft(d.version.body);
      },
    },
  );

  if (wf.isError) return <NoAccess message="流程不存在，或者你没有编辑权限。" />;
  if (!wf.data || !draft || !current) return null;
  const def = wf.data.definition;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.body);

  function onCell(from: string, to: string) {
    if (!draft) return;
    if (transitionMode(draft, from, to) === 'explicit') setSelected({ from, to });
    else {
      setDraft(toggleTransition(draft, from, to));
      setSelected(null);
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '流程模板', href: `/${org}/settings/workflows` }, { label: def.name }]}
        title={
          <span className="flex items-center gap-2">
            {def.name}
            <span className="rounded-sm bg-muted px-1.5 font-mono text-xs font-normal text-muted-foreground">
              v{current.version}
              {dirty && ' → 草稿'}
            </span>
          </span>
        }
        description={def.productId ? '这是某个产品专用的流程。' : '组织流程模板。发布新版本不会影响已在用旧版本的产品。'}
        actions={
          <>
            <VersionHistory versions={wf.data.versions} />
            <PublishDialog
              nextVersion={current.version + 1}
              disabled={!dirty || issues.length > 0}
              pending={publish.isPending}
              error={publish.error}
              onPublish={(note) => publish.mutateAsync(note)}
            />
          </>
        }
      />
      <ValidationPanel issues={issues} />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        <Tabs defaultValue="transitions" className="min-w-0">
          <TabsList>
            <TabsTrigger value="states">状态 {draft.states.length}</TabsTrigger>
            <TabsTrigger value="transitions">流转 {draft.transitions.length}</TabsTrigger>
            <TabsTrigger value="checks">检查项 {draft.checkItems.length}</TabsTrigger>
            <TabsTrigger value="gates">动作门禁 {draft.actionGates.length}</TabsTrigger>
          </TabsList>
          <div className="mt-3 rounded-lg border bg-card p-4">
            <TabsContent value="states">
              <StatesTable body={draft} onChange={setDraft} />
            </TabsContent>
            <TabsContent value="transitions">
              <TransitionMatrix body={draft} selected={selected} onCell={onCell} />
            </TabsContent>
            <TabsContent value="checks">
              <CheckItems body={draft} tags={tags.data ?? []} members={members.data ?? []} onChange={setDraft} />
            </TabsContent>
            <TabsContent value="gates">
              <ActionGate body={draft} fields={fields.data ?? []} onChange={setDraft} />
            </TabsContent>
          </div>
        </Tabs>
        <FlowPreview body={draft} selected={selected} onSelect={setSelected} />
      </div>
      <ConditionSheet body={draft} fields={fields.data ?? []} selected={selected} onChange={setDraft} onClose={() => setSelected(null)} />
    </>
  );
}
