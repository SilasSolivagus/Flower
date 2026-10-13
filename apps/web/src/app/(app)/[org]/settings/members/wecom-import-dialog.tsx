'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { WecomImportResult, WecomImportRow } from '@/lib/types';

const STATUS_LABEL: Record<WecomImportRow['status'], string> = { ok: '可匹配', unchanged: '无变化', not_found: '找不到成员', duplicate: '账号重复', invalid: '格式不对' };

/** 批量导入企业微信账号：选择 CSV（邮箱, 企业微信账号）后先预览，确认后只写入「可匹配」的行。关闭即卸载，状态不保留。 */
export function WecomImportDialog({ org, onClose }: { org: string; onClose: () => void }) {
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const preview = useApiMutation((text: string) => api<{ result: WecomImportResult }>(`/orgs/${org}/wecom-import/preview`, { method: 'POST', body: { csv: text } }), {
    silentError: true,
  });
  const apply = useApiMutation(() => api<{ result: WecomImportResult }>(`/orgs/${org}/wecom-import`, { method: 'POST', body: { csv: csv?.text ?? '' } }), {
    invalidate: [qk.members(org)],
    silentError: true,
    onSuccess: ({ result }) => {
      toast.success(`已写入 ${result.applied} 个成员的企业微信账号`);
      onClose();
    },
  });
  const result = preview.data?.result;
  const c = result?.counts;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入企业微信账号</DialogTitle>
          <DialogDescription>上传两列的 CSV：邮箱, 企业微信账号（可以带表头）。先预览，确认后只写入「可匹配」的行。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wecom-csv">CSV 文件</Label>
          <Input
            id="wecom-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              setCsv({ name: file.name, text });
              preview.mutate(text);
            }}
          />
        </div>
        <FormError error={preview.error ?? apply.error} />
        {result && c && csv && (
          <>
            <p className="text-[13px]">
              {csv.name}：可匹配 {c.ok}、无变化 {c.unchanged}、找不到成员 {c.not_found}、账号重复 {c.duplicate}、格式不对 {c.invalid}
            </p>
            <div className="max-h-72 overflow-auto rounded-md border">
              <Table aria-label="导入预览">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">行</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead>企业微信账号</TableHead>
                    <TableHead>成员</TableHead>
                    <TableHead>结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((r) => (
                    <TableRow key={r.line} className="h-10 even:bg-zebra">
                      <TableCell className="font-mono">{r.line}</TableCell>
                      <TableCell className="font-mono text-[12px]">{r.email}</TableCell>
                      <TableCell className="font-mono text-[12px]">{r.userid}</TableCell>
                      <TableCell>{r.memberName ?? '—'}</TableCell>
                      <TableCell className={r.status === 'ok' ? undefined : 'text-muted-foreground'}>
                        {STATUS_LABEL[r.status]}
                        {r.note ? `：${r.note}` : ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!c || c.ok === 0 || apply.isPending} onClick={() => apply.mutate(undefined)}>
            确认导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
