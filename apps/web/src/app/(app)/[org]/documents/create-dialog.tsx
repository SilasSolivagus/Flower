'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { documentHref } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, requirementKeys, useApiMutation, useTemplates } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

const BLANK = '__blank';
type Mode = 'native' | 'external' | 'import';

function CreateForm({
  org,
  productId,
  initialTitle,
  requirementIds,
  onCancel,
}: {
  org: string;
  productId: string;
  initialTitle: string;
  requirementIds?: string[];
  onCancel: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('native');
  const [title, setTitle] = useState(initialTitle);
  const [url, setUrl] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const templates = useTemplates(org, { productId, usable: true });
  // 未手动选择时默认用第一个可用模板；没有模板时为空白文档
  const chosen = templateId ?? templates.data?.[0]?.id ?? BLANK;
  const create = useApiMutation(
    () =>
      api<{ document: DocumentDetail }>(`/orgs/${org}/products/${productId}/documents`, {
        method: 'POST',
        body: {
          title,
          requirementIds,
          ...(mode === 'external' ? { externalUrl: url } : mode === 'import' ? {} : { templateId: chosen === BLANK ? null : chosen }),
        },
      }),
    {
      silentError: true,
      invalidate: [documentKeys(org), requirementKeys(org)],
      success: '已创建 PRD',
      onSuccess: (d) => router.push(`${documentHref(org, d.document.displayKey)}${mode === 'import' ? '?import=1' : ''}`),
    },
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined);
      }}
    >
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList>
          <TabsTrigger value="native">Flower 文档</TabsTrigger>
          <TabsTrigger value="external">外部链接</TabsTrigger>
          <TabsTrigger value="import">导入</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="doc-title">标题</Label>
        <Input id="doc-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {mode === 'native' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="doc-template">模板</Label>
          {/*
            value 受控，onValueChange 忽略空字符串：对话框的表单套在 <form> 里，Radix Select 会渲染一个隐藏的原生
            <select> 做表单语义同步；该隐藏 select 的 <option> 只在下拉菜单被打开过（SelectItem 挂载注册）后才存在，
            首次把 value 设为预置模板的 id 时找不到匹配的 option，原生 select 的值被浏览器强制归为空串，
            并经由其 onChange 把这个空串回灌成 onValueChange("")，把刚选好的模板覆盖掉。模板 id 与 BLANK 均非空串，
            过滤掉空串等于只接受真实的用户选择。
          */}
          <Select value={chosen} onValueChange={(v) => v && setTemplateId(v)}>
            <SelectTrigger id="doc-template" aria-label="模板">
              {/* 选中项的文字直接作为 children 传入：SelectValue 默认靠 SelectItem 挂载后反向 portal 回填文字，下拉从未打开过时不会显示 */}
              <SelectValue>{chosen === BLANK ? '空白文档' : templates.data?.find((t) => t.id === chosen)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(templates.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
              <SelectItem value={BLANK}>空白文档</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : mode === 'external' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="doc-url">文档网址</Label>
          <Input id="doc-url" required type="url" placeholder="https://doc.weixin.qq.com/…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <span className="text-xs text-muted-foreground">正文留在外部平台；状态流转、覆盖需求、会签与评论在 Flower 里进行。</span>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">先建一份空白 Flower 文档，下一步粘贴内容或上传 Markdown、Word 文件。</p>
      )}
      <FormError error={create.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={create.isPending || !title.trim()}>
          创建
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 新建 PRD：Flower 文档（可选模板）或外部链接。requirementIds 用于从需求详情新建时直接覆盖这条需求。 */
export function CreateDocumentDialog({
  org,
  productId,
  open,
  onOpenChange,
  initialTitle = '',
  requirementIds,
}: {
  org: string;
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTitle?: string;
  requirementIds?: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 PRD</DialogTitle>
        </DialogHeader>
        {open && <CreateForm org={org} productId={productId} initialTitle={initialTitle} requirementIds={requirementIds} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
