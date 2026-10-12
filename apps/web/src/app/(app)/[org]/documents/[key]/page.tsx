'use client';

import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { Backlinks } from '@/components/backlinks';
import { EditableTitle } from '@/components/editable-title';
import { FollowButton } from '@/components/follow-button';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { moduleDocsHref } from '@/features/documents/model';
import { useMarkNotificationsRead } from '@/features/member-notifications/use-mark-read';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useDocument } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { ImportDialog } from '../import-dialog';
import { DocumentComments } from './comments';
import { EditorPane, type EditorPaneHandle } from './editor-pane';
import { ExternalCard } from './external-card';
import { MergeRecords } from './merge-records';
import { ModuleSidePanel } from './module-side-panel';
import { SidePanel } from './side-panel';

function DocumentPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const q = useDocument(org, decodeURIComponent(key));
  const d = q.data;
  useMarkNotificationsRead(org, 'document', d?.id);
  const editor = useRef<EditorPaneHandle>(null);
  const [converting, setConverting] = useState(false);
  // 正文被外部替换（冲突后重新加载、恢复版本、导入）时加一，让编辑器按最新正文重新挂载
  const [epoch, setEpoch] = useState(0);
  // 正文里点击的评论高亮：评论区滚动并标出这一条，正文里的高亮加深
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  const reload = async () => {
    // 取数失败时不重新挂载编辑器，免得它用旧正文覆盖掉错误提示前的状态
    if ((await q.refetch()).isError) return;
    setEpoch((e) => e + 1);
  };
  // 恢复版本、改状态之前先保存编辑器里没到时间的修改；返回编辑器的版本号，外部 PRD 没有编辑器时为 null
  const saveEditor = async () => (editor.current ? editor.current.saveNow() : null);
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
  // 已归档的模块文档不能改标题、不能导入（服务端同样拒绝）
  const canEdit = d.myRole !== 'viewer' && !(d.kind === 'module' && d.status === 'archived');
  // 新建对话框选「导入」后带着 ?import=1 跳过来
  const importOpen = canEdit && (converting || searchParams.get('import') === '1');
  const closeImport = () => {
    setConverting(false);
    if (searchParams.get('import')) router.replace(pathname);
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: '文档', href: d.kind === 'module' ? moduleDocsHref(org, d.productKey, d.node?.id) : `/${org}/documents?product=${d.productKey}` }, { label: d.displayKey }]}
        title={<EditableTitle displayKey={d.displayKey} title={d.title} canEdit={canEdit} onSubmit={(title, close) => patch.mutate({ title }, { onSuccess: close })} />}
        actions={<FollowButton org={org} type="document" id={d.id} />}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {d.source === 'native' ? <EditorPane key={`${d.id}:${epoch}`} ref={editor} org={org} doc={d} onReload={() => void reload()} section={searchParams.get('section')} activeCommentId={focus?.id ?? null} onAnchorClick={(id) => setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 }))} /> : <ExternalCard org={org} doc={d} onConvert={() => setConverting(true)} />}
          <DocumentComments org={org} doc={d} focus={focus} />
          <Backlinks org={org} type="document" id={d.id} />
          {d.kind === 'module' && <MergeRecords org={org} doc={d} />}
        </div>
        {d.kind === 'module' ? (
          <ModuleSidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />
        ) : (
          <SidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />
        )}
      </div>
      <ImportDialog
        org={org}
        doc={d}
        open={importOpen}
        onOpenChange={(o) => !o && closeImport()}
        onImported={() => {
          closeImport();
          void reload();
        }}
      />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <DocumentPage />
    </Suspense>
  );
}
