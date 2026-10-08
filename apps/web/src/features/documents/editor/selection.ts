import { clipContext } from '../model';

export type SelectionAnchor = { quote: string; prefix: string; suffix: string };

/** 编辑器容器里的当前选区：引用文字、前后文与位置；选区为空、超过 500 字或不在容器里时返回 null。 */
export function selectionAnchor(container: HTMLElement, sel: Selection | null): (SelectionAnchor & { rect: DOMRect }) | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = range.toString().trim();
  if (!quote || quote.length > 500) return null;
  const before = document.createRange();
  before.setStart(container, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(container, container.childNodes.length);
  return { quote, ...clipContext(before.toString(), after.toString()), rect: range.getBoundingClientRect() };
}
