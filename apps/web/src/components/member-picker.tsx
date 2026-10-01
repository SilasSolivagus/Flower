'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { filterPickerOptions, type PickerOption } from '@/features/members/model';
import { cn } from '@/lib/utils';

/**
 * 可搜索的成员选择框：点开后输入姓名、邮箱或部门过滤，方向键移动、回车选中。
 * 触发按钮的角色是 combobox、选项的角色是 option，与原来的 Select 相同。
 * 有 noneLabel 时，搜索框为空时第一项代表「不选」（onChange(null)）。
 * `modal` 传给 Popover：picker 放在 Dialog 里时需要开启，否则弹出内容会被 Dialog 的焦点锁定影响。
 */
export function MemberPicker({
  label,
  options,
  value,
  onChange,
  noneLabel,
  placeholder = '选择成员',
  disabled,
  className,
  modal,
}: {
  label: string;
  options: PickerOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  modal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const items: Array<{ id: string | null; label: string }> = [
    ...(noneLabel && !query.trim() ? [{ id: null, label: noneLabel }] : []),
    ...filterPickerOptions(options, query).map((o) => ({ id: o.id, label: o.displayName })),
  ];
  const current = Math.min(active, items.length - 1);
  const selected = options.find((o) => o.id === value);
  const showsNone = !selected && value === null && !!noneLabel;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setQuery('');
    setActive(0);
  };
  const pick = (id: string | null) => {
    changeOpen(false);
    if (id !== value) onChange(id);
  };

  return (
    <Popover open={open} onOpenChange={changeOpen} modal={modal}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          className={cn('justify-between gap-1 px-3 font-normal', !selected && !showsNone && 'text-muted-foreground', className)}
        >
          <span className="truncate">{selected?.displayName ?? (showsNone ? noneLabel : placeholder)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <Input
          aria-label={`搜索${label}`}
          placeholder="输入姓名、邮箱或部门"
          className="mb-1 h-8"
          value={query}
          aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive(Math.min(current + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive(Math.max(current - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const item = items[current];
              if (item) pick(item.id);
            }
          }}
        />
        <ul id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
          {items.map((it, i) => (
            <li
              key={it.id ?? '__none'}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={it.id === value}
              ref={i === current ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={cn('flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px]', i === current && 'bg-accent text-accent-foreground')}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(it.id)}
            >
              <Check className={cn('size-3.5 shrink-0', it.id === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
              <span className="truncate">{it.label}</span>
            </li>
          ))}
          {items.length === 0 && <li className="px-2 py-1.5 text-[13px] text-muted-foreground">没有匹配的成员</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
