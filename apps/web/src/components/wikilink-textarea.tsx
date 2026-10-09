'use client';

import { type ComponentProps, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { activeWikiQuery, applyCompletion, SUGGESTION_KIND_LABEL } from '@/features/links/model';
import { useLinkSearch } from '@/lib/queries';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 150;

type Props = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  org: string;
  /** 来源所在产品：补全按它决定本产品优先与是否带产品前缀。 */
  productId: string;
  value: string;
  onValueChange: (value: string) => void;
  /** 补全列表的打开状态变化：用于宿主把 Esc 只关掉列表、不关掉外层对话框。 */
  onOpenChange?: (open: boolean) => void;
};

/** 纯文本输入框加 [[ 补全：按编号前缀或标题搜索（防抖 150ms），上下键选择、回车插入、Esc 关闭；输入法组字时回车不插入。 */
export function WikilinkTextarea({ org, productId, value, onValueChange, onOpenChange, onKeyDown, onBlur, className, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const q = activeWikiQuery(value, caret);
  const open = q !== null && dismissed !== q.start;
  // 查询变化时回到第一项（渲染期间调整）
  const queryKey = q ? `${q.start}:${q.query}` : null;
  const [seenQuery, setSeenQuery] = useState<string | null>(null);
  if (queryKey !== seenQuery) {
    setSeenQuery(queryKey);
    setActive(0);
  }

  // 防抖查询：至少 150ms 不再变化才传给 useLinkSearch；keepPreviousData 让列表在等待期间不闪烁
  const [debouncedQuery, setDebouncedQuery] = useState(q?.query ?? '');
  useEffect(() => {
    if (q === null) return;
    const timer = setTimeout(() => setDebouncedQuery(q.query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const search = useLinkSearch(org, productId, debouncedQuery, open);
  const items = open ? (search.data ?? []) : [];
  const index = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    onOpenChange?.(open && items.length > 0);
  }, [open, items.length, onOpenChange]);

  const pick = (i: number) => {
    const s = items[i];
    if (!s || !q) return;
    const next = applyCompletion(value, q, caret, s);
    onValueChange(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && q && !e.nativeEvent.isComposing) {
      if (items.length > 0 && e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((index + 1) % items.length);
        return;
      }
      if (items.length > 0 && e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((index - 1 + items.length) % items.length);
        return;
      }
      if (items.length > 0 && e.key === 'Enter') {
        e.preventDefault();
        pick(index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(q.start);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        {...rest}
        className={className}
        value={value}
        aria-controls={open && items.length > 0 ? listId : undefined}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={keyDown}
        onBlur={(e) => {
          if (q) setDismissed(q.start);
          onBlur?.(e);
        }}
      />
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" aria-label="链接补全" className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-[13px] shadow-md">
          {items.map((s, i) => (
            <li
              key={`${s.kind}:${s.insert}`}
              role="option"
              aria-selected={i === index}
              className={cn('flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5', i === index && 'bg-accent')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{SUGGESTION_KIND_LABEL[s.kind]}</span>
              <span className="shrink-0 font-mono">{s.displayKey}</span>
              <span className="min-w-0 truncate">{s.title}</span>
              {s.hint && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{s.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
