'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { documentHref, invalidRequirementKeys, parseRequirementKeys } from '@/features/documents/model';
import { ApiError, api } from '@/lib/api';
import { briefKeys, documentKeys, requirementKeys, useApiMutation, useTemplates } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

function CreateBriefForm({
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
  const [title, setTitle] = useState(initialTitle);
  const [templateId, setTemplateId] = useState<string | null>(null);
  // 从文档页新建时可以顺手填要覆盖的需求编号；从需求详情新建时直接覆盖那条需求
  const [keys, setKeys] = useState('');
  const templates = useTemplates(org, { productId, usable: true, kind: 'brief' });
  // 未手动选择时用第一份可用的简报模板；没有模板时服务端新建空白简报
  const chosen = templateId ?? templates.data?.[0]?.id ?? null;
  const create = useApiMutation(
    async () => {
      const bad = requirementIds ? [] : invalidRequirementKeys(keys);
      if (bad.length > 0) throw new ApiError(400, 'invalid', `无法识别的需求编号：${bad.join('、')}（应为 PAN-12 这样的写法）`, null);
      const ids =
        requirementIds ??
        (await Promise.all(parseRequirementKeys(keys).map(async (k) => (await api<{ requirement: { id: string } }>(`/orgs/${org}/requirements/${encodeURIComponent(k)}`)).requirement.id)));
      return api<{ document: DocumentDetail }>(`/orgs/${org}/products/${productId}/briefs`, {
        method: 'POST',
        body: { title, ...(ids.length > 0 ? { requirementIds: ids } : {}), ...(chosen ? { templateId: chosen } : {}) },
      });
    },
    {
      silentError: true,
      invalidate: [documentKeys(org), briefKeys(org), requirementKeys(org)],
      success: '已创建简报',
      onSuccess: (d) => router.push(documentHref(org, d.document.displayKey)),
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brief-title">标题</Label>
        <Input id="brief-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brief-template">模板</Label>
        {templates.data && templates.data.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">没有可用的简报模板，将新建空白简报。</p>
        ) : (
          // 与新建 PRD 相同：忽略隐藏原生 select 回灌的空串，选中项文字直接作为 SelectValue 的 children
          <Select value={chosen ?? ''} onValueChange={(v) => v && setTemplateId(v)}>
            <SelectTrigger id="brief-template" aria-label="模板">
              <SelectValue>{templates.data?.find((t) => t.id === chosen)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(templates.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {requirementIds ? (
        <p className="text-[13px] text-muted-foreground">新简报会覆盖当前需求。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-requirements">覆盖需求（选填）</Label>
          <Input id="brief-requirements" placeholder="PAN-12, PAN-15" value={keys} onChange={(e) => setKeys(e.target.value)} />
        </div>
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

/** 新建简报：从文档页或需求详情打开；requirementIds 用于从需求详情新建时直接覆盖这条需求。 */
export function CreateBriefDialog({
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
          <DialogTitle>新建简报</DialogTitle>
        </DialogHeader>
        {open && <CreateBriefForm org={org} productId={productId} initialTitle={initialTitle} requirementIds={requirementIds} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
