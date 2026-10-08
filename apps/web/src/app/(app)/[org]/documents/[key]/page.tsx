'use client';

import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { EditableTitle } from '@/components/editable-title';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useDocument } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { EditorPane, type EditorPaneHandle } from './editor-pane';
import { ExternalCard } from './external-card';
import { SidePanel } from './side-panel';

export default function DocumentPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const q = useDocument(org, decodeURIComponent(key));
  const d = q.data;
  const editor = useRef<EditorPaneHandle>(null);
  // 正文被外部替换（冲突后重新加载、恢复版本、导入）时加一，让编辑器按最新正文重新挂载
  const [epoch, setEpoch] = useState(0);
  const reload = async () => {
    await q.refetch();
    setEpoch((e) => e + 1);
  };
  const patch = useApiMutation(
    async (body: { title: string }) => {
      const r = await api<{ document: DocumentDetail }>(`/orgs/${org}/documents/${d!.id}`, { method: 'PATCH', body });
      // 改标题会让原生 PRD 的版本号加一；在等待列表刷新之前就交给编辑器，避免这段时间里的自动保存误报冲突
      editor.current?.onRenamed(r.document.version);
      return r;
    },
    { invalidate: [documentKeys(org)], success: '已保存' },
  );

  if (!d && q.isError) {
    return <QueryError error={q.error} noAccessMessage="PRD 不存在，或你没有查看它所在产品的权限。" retryMessage="加载 PRD 失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!d) return <Skeleton className="h-64" />;
  const canEdit = d.myRole !== 'viewer';

  return (
    <>
      <PageHeader
        crumbs={[{ label: '文档', href: `/${org}/documents?product=${d.productKey}` }, { label: d.displayKey }]}
        title={<EditableTitle displayKey={d.displayKey} title={d.title} canEdit={canEdit} onSubmit={(title, close) => patch.mutate({ title }, { onSuccess: close })} />}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {d.source === 'native' ? <EditorPane key={`${d.id}:${epoch}`} ref={editor} org={org} doc={d} onReload={() => void reload()} /> : <ExternalCard org={org} doc={d} />}
        </div>
        <SidePanel org={org} doc={d} onReload={() => void reload()} />
      </div>
    </>
  );
}
