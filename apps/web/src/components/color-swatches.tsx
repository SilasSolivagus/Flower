'use client';

import { Check } from 'lucide-react';
import { SWATCHES } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function ColorSwatches({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn(
            'flex size-6 items-center justify-center rounded-sm ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring',
            value.toLowerCase() === c && 'ring-2 ring-foreground/60',
          )}
          style={{ background: c }}
        >
          {value.toLowerCase() === c && <Check className="size-3.5 text-white" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
