'use client';

import { splitWikiText } from '@flower/core/links';
import Link from 'next/link';
import { Fragment } from 'react';
import { cardFor, cardHref, cardLabel, isGrey, LINK_STATE_NOTE } from '@/features/links/model';
import type { LinkCard } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 行内链接卡：编号、标题（或 [[ |显示文字]]）、状态。灰色时附说明；看不到目标时只有编号、不可点击。 */
export function LinkChip({ org, card, target, label }: { org: string; card: LinkCard | null; target: string; label: string | null }) {
  const href = card ? cardHref(org, card) : null;
  const grey = isGrey(card);
  const note = card ? LINK_STATE_NOTE[card.state] : '未解析';
  const title = label ?? card?.title ?? null;
  const name = cardLabel(card, target, label);
  const cls = cn(
    'mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-sm border px-1 align-baseline text-[12px] leading-5',
    grey ? 'border-dashed text-muted-foreground' : 'bg-muted/60',
  );
  const body = (
    <>
      <span className="shrink-0 font-mono">{card?.displayKey ?? target}</span>
      {title && <span className="truncate">{title}</span>}
      {card?.status && (
        <span className="shrink-0 text-[11px]" style={!grey && card.status.color ? { color: card.status.color } : undefined}>
          {card.status.label}
        </span>
      )}
      {note && <span className="shrink-0 text-[11px]">{note}</span>}
    </>
  );
  return href ? (
    <Link href={href} aria-label={name} className={cn(cls, 'hover:underline')}>
      {body}
    </Link>
  ) : (
    <span title={name} className={cls}>
      {body}
    </span>
  );
}

/** 纯文本（需求描述、评论）的显示：[[ ]] 渲染为链接卡，其余原样（保留换行）。 */
export function WikiText({
  org,
  text,
  cards,
  productKey,
  as: Tag = 'p',
  className,
}: {
  org: string;
  text: string;
  cards: LinkCard[];
  productKey: string;
  as?: 'p' | 'span';
  className?: string;
}) {
  return (
    <Tag className={cn('whitespace-pre-wrap break-words', className)}>
      {splitWikiText(text).map((s, i) =>
        s.kind === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : (
          <LinkChip key={i} org={org} card={cardFor(cards, s.link.target, productKey)} target={s.link.target} label={s.link.label} />
        ),
      )}
    </Tag>
  );
}
