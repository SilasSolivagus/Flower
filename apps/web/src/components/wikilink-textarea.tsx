'use client';

import { type ComponentProps, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { activeWikiQuery, applyCompletion, SUGGESTION_KIND_LABEL } from '@/features/links/model';
import { activeMentionQuery, applyMention, filterMentionMembers, MENTION_NO_ACCESS } from '@/features/mentions/model';
import { useLinkSearch, useMentionMembers } from '@/lib/queries';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 150;

type Props = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  org: string;
  /** 来源所在产品：[[ 补全按它决定本产品优先与是否带产品前缀；@ 补全按它标出看不到该产品的成员。 */
  productId: string;
  value: string;
  onValueChange: (value: string) => void;
  /** 补全列表的打开状态变化：用于宿主把 Esc 只关掉列表、不关掉外层对话框。 */
  onOpenChange?: (open: boolean) => void;
};

/** 一个补全项：[[ 链接或 @ 成员。 */
type Option = { key: string; kind: string; main: string; mono: boolean; title: string; hint: string | null; apply: () => { value: string; caret: number } };

/**
 * 纯文本输入框加补全：[[ 按编号前缀或标题搜索（防抖 150ms）；@ 按姓名或邮箱在本组织成员里筛选。
 * 上下键选择、回车插入、Esc 关闭；输入法组字时回车不插入。
 */
export function WikilinkTextarea({ org, productId, value, onValueChange, onOpenChange, onKeyDown, onBlur, className, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const wiki = activeWikiQuery(value, caret);
  const mention = wiki ? null : activeMentionQuery(value, caret);
  const start = wiki?.start ?? mention?.start ?? null;
  const open = start !== null && dismissed !== start;
  // 查询变化时回到第一项（渲染期间调整）
  const queryKey = wiki ? `w${wiki.start}:${wiki.query}` : mention ? `m${mention.start}:${mention.query}` : null;
  const [seenQuery, setSeenQuery] = useState<string | null>(null);
  if (queryKey !== seenQuery) {
    setSeenQuery(queryKey);
    setActive(0);
  }

  // [[ 的防抖查询：至少 150ms 不再变化才传给 useLinkSearch；keepPreviousData 让列表在等待期间不闪烁
  const query = wiki?.query ?? null;
  const [debouncedQuery, setDebouncedQuery] = useState(query ?? '');
  useEffect(() => {
    if (query === null) return;
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useLinkSearch(org, productId, debouncedQuery, open && wiki !== null);
  const members = useMentionMembers(org, productId);
  const options: Option[] = !open
    ? []
    : wiki
      ? (search.data ?? []).map((s) => ({
          key: `${s.kind}:${s.insert}`,
          kind: SUGGESTION_KIND_LABEL[s.kind],
          main: s.displayKey,
          mono: true,
          title: s.title,
          hint: s.hint,
          apply: () => applyCompletion(value, wiki, caret, s),
        }))
      : mention
        ? filterMentionMembers(members.data ?? [], mention.query).map((m) => ({
            key: m.id,
            kind: '成员',
            main: m.displayName,
            mono: false,
            title: m.email ?? '',
            hint: m.canSeeProduct ? null : MENTION_NO_ACCESS,
            apply: () => applyMention(value, mention, caret, m),
          }))
        : [];
  const index = Math.min(active, Math.max(options.length - 1, 0));
  // 结果是否对应当前输入：[[ 防抖未落定或正在用上一次查询的结果占位时都算未结算，回车不应采用；@ 在本地筛选，成员加载完即结算
  const settled = wiki ? debouncedQuery.trim() === wiki.query.trim() && !search.isPlaceholderData : mention !== null && members.data !== undefined;
  const shown = open && options.length > 0;

  useEffect(() => {
    onOpenChange?.(shown);
  }, [shown, onOpenChange]);

  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    const next = o.apply();
    onValueChange(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari 下确认输入法组字的 Enter：isComposing 已为 false，但 keyCode 仍是 229
    if (open && start !== null && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      if (options.length > 0 && e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((index + 1) % options.length);
        return;
      }
      if (options.length > 0 && e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((index - 1 + options.length) % options.length);
        return;
      }
      if (options.length > 0 && e.key === 'Enter') {
        // 列表还没落定到当前输入时，回车不采用上一次查询留下的结果；继续显示旧列表，不吞掉这次按键之外的副作用
        e.preventDefault();
        if (settled) pick(index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(start);
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
        aria-controls={shown ? listId : undefined}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={keyDown}
        onBlur={(e) => {
          if (start !== null) setDismissed(start);
          onBlur?.(e);
        }}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label={wiki ? '链接补全' : '成员补全'}
          aria-busy={!settled}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-[13px] shadow-md"
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              role="option"
              aria-selected={i === index}
              className={cn('flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5', i === index && 'bg-accent')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{o.kind}</span>
              <span className={cn('shrink-0', o.mono ? 'font-mono' : 'font-medium')}>{o.main}</span>
              <span className={cn('min-w-0 truncate', !o.mono && 'text-muted-foreground')}>{o.title}</span>
              {o.hint && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
