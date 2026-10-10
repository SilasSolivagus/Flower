'use client';

import { TEMPLATE_FORMAT_LABELS, TEMPLATE_FORMATS, type TemplateFormat } from '@flower/core/notifications';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation } from '@/lib/queries';
import type { MessageTemplate } from '@/lib/types';

const FORMAT_HINT: Record<TemplateFormat, string> = {
  text: '纯文本。',
  markdown: '企业微信 markdown：支持加粗、链接、引用与 <font color="warning|comment|info">。',
  template_card: '内容是企业微信 template_card 对象的 JSON，只替换字符串里的变量。',
  email: '第一行是邮件主题，其余为正文。',
};

/** 新建或修改模板。预置模板只能改内容。初值只在挂载时读取：父组件每次打开时重新挂载。 */
export function TemplateDialog({ org, template, onClose }: { org: string; template: MessageTemplate | null; onClose: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [format, setFormat] = useState<TemplateFormat>(template?.format ?? 'markdown');
  const [body, setBody] = useState(template?.body ?? '');
  const builtin = template?.builtin ?? false;
  const save = useApiMutation(
    () =>
      template
        ? api(`/orgs/${org}/message-templates/${template.id}`, { method: 'PATCH', body: builtin ? { body } : { name, format, body } })
        : api(`/orgs/${org}/message-templates`, { method: 'POST', body: { name, format, body } }),
    { invalidate: [notifyKeys(org)], success: '模板已保存', silentError: true, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{template ? `修改模板「${template.name}」` : '新建模板'}</DialogTitle>
            <DialogDescription>
              变量写作 {'{{path}}'}，如 {'{{subject.title}}'}；{'{{#list}}…{{/list}}'} 按列表重复，{'{{^x}}…{{/x}}'} 在为空时显示。缺少的字段显示为空。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-name">模板名称</Label>
              <Input id="tpl-name" required disabled={builtin} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-format">格式</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as TemplateFormat)} disabled={builtin}>
                <SelectTrigger id="tpl-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {TEMPLATE_FORMAT_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tpl-body">内容</Label>
            <Textarea id="tpl-body" required rows={14} className="font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
            <span className="text-xs text-muted-foreground">{FORMAT_HINT[format]}</span>
          </div>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
