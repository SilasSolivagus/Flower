'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PRODUCT_ROLE_LABEL } from '@/lib/labels';
import type { FunctionTag, Member, WorkflowBody } from '@/lib/types';
import { addCheckItem, type CheckItem, removeCheckItem } from '../model';

type Signer = NonNullable<CheckItem['signers']>[number];

export function CheckItems({
  body,
  tags,
  members,
  onChange,
}: {
  body: WorkflowBody;
  tags: FunctionTag[];
  members: Member[];
  onChange: (b: WorkflowBody) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Omit<CheckItem, 'key' | 'defaultState'>>({ label: '', scope: 'requirement', type: 'single' });
  const [signer, setSigner] = useState<Signer>({ by: 'function_tag', ref: '' });
  const signerLabel = (s: Signer) =>
    s.by === 'function_tag'
      ? `职能：${tags.find((t) => t.id === s.ref)?.name ?? '已删除的标签'}`
      : s.by === 'member'
        ? `成员：${members.find((m) => m.id === s.ref)?.displayName ?? '已删除的成员'}`
        : `产品角色：${PRODUCT_ROLE_LABEL[s.ref as keyof typeof PRODUCT_ROLE_LABEL] ?? s.ref}`;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y rounded-md border">
        {body.checkItems.length === 0 && <li className="px-3 py-4 text-[13px] text-muted-foreground">还没有检查项。</li>}
        {body.checkItems.map((c) => (
          <li key={c.key} className="flex items-center gap-3 px-3 py-2">
            <span className="font-medium">{c.label}</span>
            <span className="font-mono text-xs text-muted-foreground">{c.key}</span>
            <span className="text-xs text-muted-foreground">
              {c.scope === 'document' ? '作用于 PRD' : '作用于需求'} · {c.type === 'signoff' ? `会签（${c.signoffRule === 'all' ? '全部通过' : '任一通过'}）` : '普通'}
              {c.auto === 'prd_status' && ' · 自动同步 PRD 状态'}
            </span>
            <span className="flex-1 truncate text-xs text-muted-foreground">{c.signers?.map(signerLabel).join('、')}</span>
            <ConfirmAction
              trigger={
                <Button variant="ghost" size="icon" aria-label={`删除 ${c.label}`}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              }
              title={`删除检查项「${c.label}」？`}
              description="引用它的流转条件和门禁条件会一并删除。"
              confirmLabel="确认删除"
              destructive
              onConfirm={() => onChange(removeCheckItem(body, c.key))}
            />
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          setDraft({ label: '', scope: 'requirement', type: 'single' });
          setOpen(true);
        }}
      >
        新增检查项
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onChange(addCheckItem(body, draft));
              setOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>新增检查项</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ci-label">检查项名称</Label>
              <Input id="ci-label" required value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ci-scope">作用范围</Label>
                <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v as CheckItem['scope'], auto: undefined })}>
                  <SelectTrigger id="ci-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="requirement">需求</SelectItem>
                    <SelectItem value="document">PRD（覆盖的需求共享结果）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ci-type">类型</Label>
                <Select
                  value={draft.type}
                  onValueChange={(v) =>
                    setDraft(v === 'signoff' ? { ...draft, type: 'signoff', signers: [], signoffRule: 'all' } : { ...draft, type: 'single', signers: undefined, signoffRule: undefined })
                  }
                >
                  <SelectTrigger id="ci-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">普通</SelectItem>
                    <SelectItem value="signoff">会签</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {draft.scope === 'document' && (
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={draft.auto === 'prd_status'} onCheckedChange={(v) => setDraft({ ...draft, auto: v ? 'prd_status' : undefined })} />
                由 PRD 模块自动同步状态（不可手动修改）
              </label>
            )}
            {draft.type === 'signoff' && (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <span className="text-sm font-medium">签字人</span>
                <ul className="flex flex-wrap gap-1.5">
                  {draft.signers?.map((s, i) => (
                    <li key={i} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                      {signerLabel(s)}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Select value={signer.by} onValueChange={(v) => setSigner({ by: v as Signer['by'], ref: '' })}>
                    <SelectTrigger className="w-28" aria-label="签字人类型">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="function_tag">职能</SelectItem>
                      <SelectItem value="member">成员</SelectItem>
                      <SelectItem value="product_role">产品角色</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={signer.ref} onValueChange={(ref) => setSigner({ ...signer, ref })}>
                    <SelectTrigger className="flex-1" aria-label="签字人">
                      <SelectValue placeholder="选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {signer.by === 'function_tag' &&
                        tags.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      {signer.by === 'member' &&
                        members
                          .filter((m) => m.status === 'active')
                          .map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.displayName}
                            </SelectItem>
                          ))}
                      {signer.by === 'product_role' &&
                        (['admin', 'editor', 'viewer'] as const).map((r) => (
                          <SelectItem key={r} value={r}>
                            {PRODUCT_ROLE_LABEL[r]}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!signer.ref}
                    onClick={() => setDraft({ ...draft, signers: [...(draft.signers ?? []), signer] })}
                  >
                    加入
                  </Button>
                </div>
                <Select value={draft.signoffRule} onValueChange={(v) => setDraft({ ...draft, signoffRule: v as 'all' | 'any' })}>
                  <SelectTrigger aria-label="会签规则">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部签字人通过</SelectItem>
                    <SelectItem value="any">任一签字人通过</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit">添加检查项</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
