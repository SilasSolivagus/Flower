'use client';

import { useState } from 'react';
import { expiryFromChoice } from '@/features/tokens/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useProducts } from '@/lib/queries';
import type { Member, TokenScope } from '@/lib/types';
import { CopyField } from './copy-field';
import { FormError } from './form-error';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

type Expiry = '30d' | '90d' | '365d' | 'never';

export function IssueTokenDialog({
  org,
  open,
  onOpenChange,
  memberId,
  agents = [],
}: {
  org: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberId?: string;
  agents?: Member[];
}) {
  const products = useProducts(org);
  const [target, setTarget] = useState(memberId ?? agents[0]?.id ?? '');
  const [name, setName] = useState('');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [access, setAccess] = useState<TokenScope['access']>('read');
  const [expiry, setExpiry] = useState<Expiry>('90d');
  const [token, setToken] = useState<string | null>(null);
  const m = useApiMutation(
    () =>
      api<{ token: string }>(`/orgs/${org}/tokens`, {
        method: 'POST',
        body: { memberId: memberId ?? target, name, scope: { products: all ? 'all' : picked, access }, expiresAt: expiryFromChoice(expiry) },
      }),
    { invalidate: [qk.tokens(org)], silentError: true, onSuccess: (d) => setToken(d.token) },
  );
  function close(v: boolean) {
    if (!v) {
      setToken(null);
      setName('');
      setPicked([]);
      m.reset();
    }
    onOpenChange(v);
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(e) => {
          if (token) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (token) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>签发 Token</DialogTitle>
          <DialogDescription>实际权限 = 持有者当前的权限 ∩ Token 的范围。持有者权限被下调时，Token 随之收窄。</DialogDescription>
        </DialogHeader>
        {token ? (
          <>
            <CopyField label="Token（只显示一次）" value={token} />
            <p className="text-[13px] text-muted-foreground">关闭后无法再次查看。请立即保存好这个 Token。</p>
            <DialogFooter>
              <Button onClick={() => close(false)}>我已保存</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate(undefined);
            }}
          >
            {!memberId && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tk-agent">Agent</Label>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id="tk-agent">
                    <SelectValue placeholder="选择 Agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tk-name">Token 名称</Label>
              <Input id="tk-name" required placeholder="例如 Claude Code" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">产品范围</legend>
              <div role="radiogroup" className="flex gap-4 text-[13px]">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="tk-scope" checked={all} onChange={() => setAll(true)} className="accent-[var(--primary)]" />
                  全部产品
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="tk-scope" checked={!all} onChange={() => setAll(false)} className="accent-[var(--primary)]" />
                  指定产品
                </label>
              </div>
              {!all && (
                <div className="flex flex-wrap gap-3 rounded-md border p-3">
                  {products.data?.map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 text-[13px]">
                      <Checkbox
                        aria-label={`${p.key} ${p.name}`}
                        checked={picked.includes(p.id)}
                        onCheckedChange={(v) => setPicked(v ? [...picked, p.id] : picked.filter((x) => x !== p.id))}
                      />
                      <span className="font-mono text-xs">{p.key}</span> {p.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">访问方式</legend>
              <div role="radiogroup" className="flex gap-4 text-[13px]">
                {(['read', 'write'] as const).map((a) => (
                  <label key={a} className="flex items-center gap-1.5">
                    <input type="radio" name="tk-access" checked={access === a} onChange={() => setAccess(a)} className="accent-[var(--primary)]" />
                    {a === 'read' ? '只读' : '读写'}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tk-exp">有效期</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as Expiry)}>
                <SelectTrigger id="tk-exp">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30d">30 天</SelectItem>
                  <SelectItem value="90d">90 天</SelectItem>
                  <SelectItem value="365d">1 年</SelectItem>
                  <SelectItem value="never">永不过期</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FormError error={m.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                取消
              </Button>
              <Button type="submit" disabled={m.isPending || (!all && picked.length === 0)}>
                签发
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
