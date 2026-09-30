import { describe, expect, it } from 'vitest';
import { parseRequirementKey, relationPhrase } from './relations';

describe('需求关联的读法', () => {
  it('有方向的关联在两端读法不同', () => {
    expect(relationPhrase('blocks', 'out')).toEqual({ before: '阻塞了', after: '' });
    expect(relationPhrase('blocks', 'in')).toEqual({ before: '被', after: '阻塞' });
    expect(relationPhrase('merged_into', 'out')).toEqual({ before: '已合并到', after: '' });
    expect(relationPhrase('merged_into', 'in')).toEqual({ before: '', after: '已合并到本需求' });
    expect(relationPhrase('duplicate_of', 'in')).toEqual({ before: '', after: '与本需求重复' });
    expect(relationPhrase('related', 'in')).toEqual({ before: '相关', after: '' });
    expect(relationPhrase('unknown', 'out')).toEqual({ before: 'unknown', after: '' });
  });

  it('完整编号识别为跨产品查找，其他输入按关键词搜索', () => {
    expect(parseRequirementKey(' doc-12 ')).toBe('DOC-12');
    expect(parseRequirementKey('PAN-3')).toBe('PAN-3');
    expect(parseRequirementKey('断点续传')).toBeNull();
    expect(parseRequirementKey('12')).toBeNull();
  });
});
