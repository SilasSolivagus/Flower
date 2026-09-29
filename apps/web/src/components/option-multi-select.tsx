'use client';

import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type MultiOption = { id: string; label: string; color?: string | null };

export function OptionMultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: MultiOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('h-8 gap-1', value.length > 0 && 'border-primary text-primary')}>
          {label}
          {value.length > 0 && <span className="font-mono text-xs">· {value.length}</span>}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <ul aria-label={label} className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <li key={o.id}>
              <label className="flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-[13px] hover:bg-accent">
                <Checkbox checked={value.includes(o.id)} onCheckedChange={() => toggle(o.id)} aria-label={o.label} />
                {o.color && <span className="size-2 rounded-full" style={{ background: o.color }} aria-hidden="true" />}
                <span className="truncate">{o.label}</span>
              </label>
            </li>
          ))}
        </ul>
        {value.length > 0 && (
          <Button variant="ghost" size="sm" className="mt-1 h-7 w-full" onClick={() => onChange([])}>
            清除
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
