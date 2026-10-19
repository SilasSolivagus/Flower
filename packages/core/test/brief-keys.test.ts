import { describe, expect, it } from 'vitest';
import {
  BRIEF_TRANSITIONS,
  briefDisplayKey,
  canTransition,
  DOCUMENT_STATUS_LABELS,
  documentKeyOf,
  documentTransitions,
  parseBriefKey,
  parseDocumentKey,
} from '../src/documents/markdown';
import { canonicalWikiText, classifyTarget, parseWikilinks } from '../src/links/syntax';

describe('简报编号', () => {
  it('显示与解析；PRD 编号与简报编号互不混淆', () => {
    expect(briefDisplayKey('PAN', 3)).toBe('PAN-B-3');
    expect(documentKeyOf('brief', 'PAN', 3)).toBe('PAN-B-3');
    expect(documentKeyOf('change', 'PAN', 3)).toBe('PAN-PRD-3');
    expect(documentKeyOf('module', 'PAN', 3)).toBe('PAN-PRD-3');
    expect(parseBriefKey(' PAN-B-12 ')).toEqual({ productKey: 'PAN', number: 12 });
    expect(parseBriefKey('PAN-PRD-12')).toBeNull();
    expect(parseBriefKey('pan-b-1')).toBeNull();
    expect(parseDocumentKey('PAN-B-12')).toBeNull();
  });
});

describe('简报状态与流转', () => {
  it('中文名称', () => {
    expect([DOCUMENT_STATUS_LABELS.discussing, DOCUMENT_STATUS_LABELS.ready, DOCUMENT_STATUS_LABELS.converted, DOCUMENT_STATUS_LABELS.discarded]).toEqual([
      '讨论中',
      '可写 PRD',
      '已转 PRD',
      '已废弃',
    ]);
  });

  it('按文档类型取流转；已转 PRD 只由转换进入；PRD 的流转不变', () => {
    expect(documentTransitions('brief', 'discussing')).toEqual(['ready', 'discarded']);
    expect(documentTransitions('brief', 'ready')).toEqual(['discussing', 'discarded']);
    expect(documentTransitions('brief', 'converted')).toEqual(['discussing', 'discarded']);
    expect(documentTransitions('brief', 'discarded')).toEqual(['discussing']);
    expect(documentTransitions('brief', 'draft')).toEqual([]);
    expect(documentTransitions('change', 'discarded')).toEqual(['draft']);
    expect(documentTransitions('module', 'active')).toEqual(['archived']);
    expect(Object.values(BRIEF_TRANSITIONS).flat()).not.toContain('converted');
    expect(canTransition('discussing', 'ready', 'brief')).toBe(true);
    expect(canTransition('discussing', 'draft', 'brief')).toBe(false);
    expect(canTransition('draft', 'discussing')).toBe(false);
    expect(canTransition('draft', 'review')).toBe(true);
  });
});

describe('[[ ]] 里的简报编号', () => {
  it('识别为简报，可带小节；规范写法大写；不影响 PRD、需求与任务', () => {
    expect(classifyTarget('pan-b-3#数据依据')).toEqual({ kind: 'brief', productKey: 'PAN', number: 3, section: '数据依据' });
    expect(classifyTarget('PAN-B-3')).toEqual({ kind: 'brief', productKey: 'PAN', number: 3, section: null });
    expect(canonicalWikiText('pan-b-3', 'DOC')).toBe('PAN-B-3');
    expect(canonicalWikiText('PAN-B-3#2. 数据依据', 'PAN')).toBe('PAN-B-3#2. 数据依据');
    expect(classifyTarget('PAN-PRD-3').kind).toBe('document');
    expect(classifyTarget('PAN-T-3').kind).toBe('task');
    expect(classifyTarget('PAN-3').kind).toBe('requirement');
    expect(parseWikilinks('见 [[PAN-B-3|简报]]')[0]).toMatchObject({ target: 'PAN-B-3', label: '简报' });
  });
});
