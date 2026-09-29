'use client';

import { Check } from 'lucide-react';
import type { WorkflowBody } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ANY, getConditions, transitionMode } from '../model';

export function TransitionMatrix({
  body,
  selected,
  onCell,
}: {
  body: WorkflowBody;
  selected: { from: string; to: string } | null;
  onCell: (from: string, to: string) => void;
}) {
  const states = [...body.states].sort((a, b) => a.order - b.order);
  const rows = [{ key: ANY, label: '任意状态' }, ...states.map((s) => ({ key: s.key, label: s.label }))];
  return (
    <div className="overflow-x-auto">
      <div className="mb-3 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-accent" />
          允许
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border border-dashed border-primary/60" />
          由“任意状态”规则允许
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-amber-600" />
          有条件
        </span>
        <span>点击空格新增流转，点击已允许的格子编辑条件</span>
      </div>
      <table className="border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="w-24 text-left align-bottom text-[11px] font-normal text-muted-foreground">从 ↓ 到 →</th>
            {states.map((s) => (
              <th key={s.key} className="h-16 w-8 align-bottom text-xs font-normal text-muted-foreground [writing-mode:vertical-rl]">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className={cn('pr-2 text-left text-[13px] font-normal', r.key === ANY && 'text-muted-foreground')}>
                {r.label}
              </th>
              {states.map((c) => {
                if (r.key === c.key) return <td key={c.key} className="size-8 rounded-sm bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_6px)]" />;
                const mode = transitionMode(body, r.key, c.key);
                const cond = mode === 'explicit' && getConditions(body, r.key, c.key).length > 0;
                const sel = selected?.from === r.key && selected.to === c.key;
                const name =
                  mode === 'explicit' ? `${r.label} 到 ${c.label}：允许${cond ? '，有条件' : ''}` : mode === 'implied' ? `${r.label} 到 ${c.label}：由任意状态规则允许` : `${r.label} 到 ${c.label}：不允许`;
                return (
                  <td key={c.key}>
                    <button
                      type="button"
                      aria-label={name}
                      onClick={() => onCell(r.key, c.key)}
                      className={cn(
                        'relative flex size-8 items-center justify-center rounded-sm border',
                        mode === 'explicit' && 'border-transparent bg-accent text-primary',
                        mode === 'implied' && 'border-dashed border-primary/60',
                        mode === 'none' && 'bg-card',
                        sel && 'bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2',
                      )}
                    >
                      {mode !== 'none' && <Check className="size-3.5" aria-hidden="true" />}
                      {cond && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-600" />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
