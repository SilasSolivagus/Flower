import { createExtension } from '@blocknote/core';
import { type TextPart, wikiRangesInBlock } from '@flower/core/links';
import { type EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { cardFor, cardLabel, isGrey, LINK_STATE_NOTE } from '@/features/links/model';
import type { LinkCard } from '@/lib/types';

/** 推给编辑器的显示数据：正文里 [[ ]] 的链接卡。只影响显示，不改正文。 */
export type DecorationInput = { org: string; productKey: string; cards: LinkCard[] };
type State = { input: DecorationInput | null; set: DecorationSet };
type Doc = EditorState['doc'];

export const decorationsKey = new PluginKey<State>('flower-decorations');

/** 链接卡挂件：标题、状态、说明放在 data-label，由 CSS ::after 显示，不进入 DOM 文本（划词评论读取前后文时不会读到）。 */
function chip(card: LinkCard | null, target: string, org: string): HTMLElement {
  const href = card?.href ? `/${org}/${card.href}` : null;
  const el = document.createElement(href ? 'a' : 'span');
  el.className = 'wikilink-card';
  el.contentEditable = 'false';
  el.dataset.state = card?.state ?? 'missing';
  el.dataset.label = [card?.title, card?.status?.label, card ? LINK_STATE_NOTE[card.state] : '未解析'].filter(Boolean).join(' · ');
  el.setAttribute('aria-label', cardLabel(card, target));
  if (href) {
    el.setAttribute('href', href);
    el.dataset.wikilinkHref = href;
  }
  return el;
}

function build(doc: Doc, input: DecorationInput | null): DecorationSet {
  if (!input) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    const parts: TextPart[] = [];
    node.forEach((child, offset) => {
      if (child.isText) parts.push({ text: child.text ?? '', pos: pos + 1 + offset, code: child.marks.some((m) => m.type.name === 'code') });
    });
    for (const r of wikiRangesInBlock(parts)) {
      const card = cardFor(input.cards, r.target, input.productKey);
      decos.push(Decoration.inline(r.from, r.to, { class: isGrey(card) ? 'wikilink wikilink-grey' : 'wikilink' }));
      decos.push(
        Decoration.widget(r.to, () => chip(card, r.target, input.org), {
          side: 1,
          ignoreSelection: true,
          key: `${r.target}|${card?.state ?? 'missing'}|${card?.title ?? ''}|${card?.status?.label ?? ''}`,
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/**
 * 显示用的装饰插件：收到只带元数据的事务（decorationsKey）时按新数据重画，文档变化时按新文档重画。
 * 元数据事务不改文档，不触发 BlockNote 的 onChange，因此不会引起自动保存。
 */
export function flowerDecorations() {
  return createExtension({
    key: 'flowerDecorations',
    prosemirrorPlugins: [
      new Plugin<State>({
        key: decorationsKey,
        state: {
          init: () => ({ input: null, set: DecorationSet.empty }),
          apply: (tr, prev, _old, next) => {
            const input = tr.getMeta(decorationsKey) as DecorationInput | undefined;
            if (input) return { input, set: build(next.doc, input) };
            if (tr.docChanged) return { input: prev.input, set: build(next.doc, prev.input) };
            return prev;
          },
        },
        props: { decorations: (state) => decorationsKey.getState(state)?.set },
      }),
    ],
  });
}
