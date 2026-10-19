'use client';

import { FileText, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { sectionsFromBody } from '@/features/documents/model';
import { api } from '@/lib/api';
import { templateKeys, useApiMutation, useTemplates } from '@/lib/queries';
import type { DocumentTemplate, TemplateKind, TemplateSection } from '@/lib/types';

const KIND_LABEL: Record<TemplateKind, string> = { change: 'PRD 模板', brief: '简报模板' };
const KINDS: TemplateKind[] = ['change', 'brief'];

function TemplateDialog({
  org,
  productId,
  kind,
  template,
  onClose,
}: {
  org: string;
  productId: string | null;
  kind: TemplateKind;
  template: DocumentTemplate | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [guidance, setGuidance] = useState(template?.guidance ?? '');
  const [sections, setSections] = useState<TemplateSection[]>(template?.sections ?? []);
  const save = useApiMutation(
    () =>
      template
        ? api(`/orgs/${org}/templates/${template.id}`, { method: 'PATCH', body: { name, body, sections, guidance } })
        : api(`/orgs/${org}/templates`, { method: 'POST', body: { productId, kind, name, body, sections, guidance } }),
    { silentError: true, invalidate: [templateKeys(org)], success: '已保存模板', onSuccess: onClose },
  );
  const update = (i: number, patch: Partial<TemplateSection>) => setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{template ? '编辑模板' : '新建模板'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-name">模板名称</Label>
          <Input id="tpl-name" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-guidance">模板说明</Label>
          <Textarea id="tpl-guidance" className="min-h-20 text-[13px]" maxLength={2000} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          <span className="text-xs text-muted-foreground">选填。显示在用这份模板写的文档的编辑器上方。</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-body">模板正文</Label>
          <Textarea id="tpl-body" className="min-h-48 font-mono text-[12px]" value={body} onChange={(e) => setBody(e.target.value)} />
          <span className="text-xs text-muted-foreground">Markdown。可以用 {'{{date}}'}（当天日期）与 {'{{author}}'}（新建人）占位。</span>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">小节</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setSections(sectionsFromBody(body))}>
                从正文提取小节
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setSections((prev) => [...prev, { heading: '', required: false }])}>
                添加小节
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {kind === 'brief' ? '简报的必填小节用于「写 PRD 前检查」第 1 项（第 1–14 节）；未勾完也可以生成 PRD。' : '提交评审时检查必填小节：标题存在，且内容不只是模板原文。'}
          </p>
          <ul className="flex flex-col gap-2">
            {sections.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Input aria-label={`小节 ${i + 1} 标题`} className="h-8 w-48" value={s.heading} onChange={(e) => update(i, { heading: e.target.value })} />
                <label className="flex items-center gap-1.5 text-[13px]">
                  <Checkbox aria-label={`小节 ${i + 1} 必填`} checked={s.required} onCheckedChange={(v) => update(i, { required: v === true })} />
                  必填
                </label>
                <Input aria-label={`小节 ${i + 1} 说明`} placeholder="写作说明（选填）" className="h-8 min-w-0 flex-1" value={s.guidance ?? ''} onChange={(e) => update(i, { guidance: e.target.value })} />
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`删除小节 ${i + 1}`} onClick={() => setSections((prev) => prev.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <FormError error={save.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={save.isPending || !name.trim()} onClick={() => save.mutate(undefined)}>
            保存模板
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function scopeNote(productId: string | null, kind: TemplateKind): string {
  if (!productId) return kind === 'brief' ? '组织内所有产品新建简报时可用；产品管理员可以在产品设置里用同名模板覆盖。' : '组织内所有产品可用；产品管理员可以在产品设置里用同名模板覆盖。';
  return kind === 'brief' ? '只用于本产品。与组织模板同名时，新建简报用本产品的版本。' : '只用于本产品。与组织模板同名时，新建 PRD 用本产品的版本。';
}

/** 文档模板列表与编辑，用「模板类型」切换 PRD 模板与简报模板。productId 为 null 时是组织模板（组织管理员），否则是该产品的覆盖模板（产品管理员）。 */
export function TemplateEditor({ org, productId }: { org: string; productId: string | null }) {
  const [kind, setKind] = useState<TemplateKind>('change');
  const list = useTemplates(org, productId ? { productId, kind } : { kind });
  const [editing, setEditing] = useState<DocumentTemplate | 'new' | null>(null);
  const invalidate = [templateKeys(org)];
  const preset = useApiMutation(() => api(`/orgs/${org}/templates/preset?kind=${kind}`, { method: 'POST' }), { invalidate, success: '已添加预置模板' });
  const toggle = useApiMutation((t: DocumentTemplate) => api(`/orgs/${org}/templates/${t.id}`, { method: 'PATCH', body: { active: !t.active } }), { invalidate });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => v && setKind(v as TemplateKind)}>
            <SelectTrigger className="h-8 w-32" aria-label="模板类型">
              <SelectValue>{KIND_LABEL[kind]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[13px] text-muted-foreground">{scopeNote(productId, kind)}</p>
        </div>
        <div className="flex gap-2">
          {!productId && list.data?.length === 0 && (
            <Button variant="outline" disabled={preset.isPending} onClick={() => preset.mutate(undefined)}>
              添加预置模板
            </Button>
          )}
          <Button onClick={() => setEditing('new')}>新建模板</Button>
        </div>
      </div>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="没有查看模板的权限。" retryMessage="加载模板失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-32" />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="还没有模板"
          description={productId ? '没有覆盖时使用组织模板。' : kind === 'brief' ? '可以添加预置的需求简报模板。' : '可以先添加与旧 PRD 一致的预置模板。'}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>必填小节</TableHead>
                <TableHead className="w-20">启用</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((t) => (
                <TableRow key={t.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="truncate text-[13px] text-muted-foreground">
                    {t.sections
                      .filter((s) => s.required)
                      .map((s) => s.heading)
                      .join('、') || '—'}
                  </TableCell>
                  <TableCell>
                    <Switch aria-label={`启用 ${t.name}`} checked={t.active} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(t)} />
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                      编辑
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && (
        <TemplateDialog
          key={editing === 'new' ? `new-${kind}` : editing.id}
          org={org}
          productId={productId}
          kind={kind}
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
