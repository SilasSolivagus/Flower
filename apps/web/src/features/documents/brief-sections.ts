import { normalizeHeading, plainText, type Section, splitSections, squash } from '@flower/core/markdown';

/** 与服务端 brief-model 相同：表格分隔行不算内容，其余去掉 Markdown 符号与空白。 */
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const norm = (line: string): string => (RULE.test(line) ? '' : squash(plainText(line.trim())));
/** 与服务端相同：写了「不适用」或「不涉及」，理由可空。 */
const NOT_APPLICABLE = /^(?:不涉及|不适用)(?:[:：](.*))?$/;

/** 小节标题的比较键：去掉编辑器加上的反斜杠、开头编号与空白。 */
export const briefSectionKey = (heading: string): string => normalizeHeading(heading.replace(/\\/g, ''));

export type BriefSectionFold = {
  heading: string;
  key: string;
  /** 空白，或只写了不适用/不涉及但没有理由。 */
  unfilled: boolean;
  /** 去掉模板原样内容后，只剩下不适用/不涉及（有无理由都算）。 */
  notApplicable: boolean;
};

function ownLines(sections: Section[], index: number): string[] {
  const lines = sections[index]!.markdown.split('\n').slice(1);
  for (let j = index + 1; j < sections.length && sections[j]!.level > sections[index]!.level; j++) lines.push(...sections[j]!.markdown.split('\n'));
  return lines;
}

function fillState(lines: string[], template: Set<string>): 'filled' | 'blank' | 'no_reason' {
  const own = lines.map(norm).filter((l) => l !== '' && !template.has(l));
  if (own.length === 0) return 'blank';
  return own.every((l) => {
    const m = NOT_APPLICABLE.exec(l);
    return m !== null && !m[1];
  })
    ? 'no_reason'
    : 'filled';
}

/** 按二级标题列出折叠状态。已填的节（含写了理由的不适用）不折叠；计数用 unfilled。 */
export function briefSectionFolds(markdown: string, templateBody: string | null): BriefSectionFold[] {
  const sections = splitSections(markdown);
  const template = new Set((templateBody ?? '').split('\n').map(norm).filter((l) => l !== ''));
  const out: BriefSectionFold[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (s.level !== 2 || !s.heading) continue;
    const lines = ownLines(sections, i);
    const own = lines.map(norm).filter((l) => l !== '' && !template.has(l));
    const state = fillState(lines, template);
    out.push({
      heading: s.heading,
      key: briefSectionKey(s.heading),
      unfilled: state !== 'filled',
      notApplicable: own.length > 0 && own.every((l) => NOT_APPLICABLE.test(l)),
    });
  }
  return out;
}

const COLLAPSED_CLASS = 'brief-section-collapsed';

/**
 * 未展开的未填二级节：标题留着，后面的块收起。不往编辑器节点里插按钮，避免编辑器重绘循环。
 */
export function applyBriefFolds(root: HTMLElement, folds: BriefSectionFold[], open: ReadonlySet<string>): void {
  root.querySelectorAll(`.${COLLAPSED_CLASS}`).forEach((el) => el.classList.remove(COLLAPSED_CLASS));

  const headings = [...root.querySelectorAll<HTMLElement>('[data-content-type="heading"][data-level="2"]')];
  const outers: HTMLElement[] = [];
  const keys: string[] = [];
  for (const heading of headings) {
    const outer = heading.closest('.bn-block-outer');
    if (!(outer instanceof HTMLElement) || outers.includes(outer)) continue;
    outers.push(outer);
    keys.push(briefSectionKey(heading.textContent ?? ''));
  }
  const foldByKey = new Map(folds.map((f) => [f.key, f]));
  for (let i = 0; i < outers.length; i++) {
    const fold = foldByKey.get(keys[i] ?? '');
    if (!fold?.unfilled || open.has(fold.key)) continue;
    const next = outers[i + 1] ?? null;
    let sib = outers[i]!.nextElementSibling;
    while (sib && sib !== next) {
      sib.classList.add(COLLAPSED_CLASS);
      sib = sib.nextElementSibling;
    }
  }
}
