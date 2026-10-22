'use client';

import { Check, Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function CopyField({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            const input = document.getElementById(id) as HTMLInputElement | null;
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setFailed(false);
              onCopied?.();
              return;
            } catch {
              input?.focus();
              input?.select();
            }
            let manual = false;
            try {
              manual = document.execCommand('copy');
            } catch {
              manual = false;
            }
            if (manual) {
              setCopied(true);
              setFailed(false);
              onCopied?.();
              return;
            }
            setCopied(false);
            setFailed(true);
          }}
        >
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          复制失败，请手动选中文本复制。
        </p>
      )}
    </div>
  );
}
