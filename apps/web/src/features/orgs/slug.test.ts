import { describe, expect, it } from 'vitest';
import { suggestSlug } from './slug';

describe('suggestSlug', () => {
  it('英文名转小写连字符', () => {
    expect(suggestSlug('Acme Cloud  Inc.')).toBe('acme-cloud-inc');
  });
  it('保留数字，去掉首尾连字符，截断到 40 位', () => {
    expect(suggestSlug('--123 Pan--')).toBe('123-pan');
    expect(suggestSlug('a'.repeat(60))).toHaveLength(40);
  });
  it('没有可用字符时返回空字符串，由用户手动填写', () => {
    expect(suggestSlug('云盘')).toBe('');
  });
});
