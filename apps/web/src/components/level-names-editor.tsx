'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LevelNamesEditor({
  value,
  onSave,
  onClear,
  saving,
}: {
  value: string[];
  onSave: (names: string[]) => void;
  onClear?: () => void;
  saving: boolean;
}) {
  const [names, setNames] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setNames(value);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        {names.map((n, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Label htmlFor={`lvl-${i}`}>第 {i + 1} 层</Label>
            <Input id={`lvl-${i}`} className="w-32" value={n} onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
        <Button type="button" variant="outline" size="icon" aria-label="增加一层" disabled={names.length >= 3} onClick={() => setNames([...names, ''])}>
          <Plus className="size-4" aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" size="icon" aria-label="减少一层" disabled={names.length <= 1} onClick={() => setNames(names.slice(0, -1))}>
          <Minus className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">最多 3 层，每层名称不超过 10 个字。需求可以挂在任意一层。</p>
      <div className="flex gap-2">
        <Button type="button" onClick={() => onSave(names)} disabled={saving}>
          保存层级叫法
        </Button>
        {onClear && (
          <Button type="button" variant="ghost" onClick={onClear} disabled={saving}>
            恢复使用组织设置
          </Button>
        )}
      </div>
    </div>
  );
}
