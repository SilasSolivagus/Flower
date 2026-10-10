'use client';

import { TEMPLATE_FORMAT_LABELS } from '@flower/core/notifications';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadError } from '@/components/load-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useMessageTemplates } from '@/lib/queries';
import type { MessageTemplate } from '@/lib/types';
import { TemplateDialog } from './template-dialog';

export function TemplatesTab({ org }: { org: string }) {
  const q = useMessageTemplates(org);
  const [open, setOpen] = useState<{ template: MessageTemplate | null } | null>(null);
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/message-templates/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '模板已删除' });
  if (q.isError) return <LoadError message="加载模板失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">规则与定时推送不指定模板时使用对应的预置模板。预置模板可以改内容，不能删除。</p>
        <Button onClick={() => setOpen({ template: null })}>新建模板</Button>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="w-28">格式</TableHead>
              <TableHead className="w-48">使用情况</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.map((t) => (
              <TableRow key={t.id} className="h-10 even:bg-zebra">
                <TableCell className="font-medium">
                  {t.name}
                  {t.builtin && (
                    <Badge variant="secondary" className="ml-2">
                      预置
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{TEMPLATE_FORMAT_LABELS[t.format]}</TableCell>
                <TableCell className="text-[13px] text-muted-foreground">
                  规则 {t.usage.rules} · 定时推送 {t.usage.schedules}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpen({ template: t })}>
                    修改
                  </Button>
                  {!t.builtin && t.usage.rules + t.usage.schedules === 0 && (
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          删除
                        </Button>
                      }
                      title={`删除模板「${t.name}」？`}
                      description="删除后不能恢复。"
                      confirmLabel="确认删除"
                      destructive
                      onConfirm={() => remove.mutate(t.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {open && <TemplateDialog key={open.template?.id ?? 'new'} org={org} template={open.template} onClose={() => setOpen(null)} />}
    </section>
  );
}
