import { describe, expect, it } from 'vitest';
import { moveItem } from './model';

describe('moveItem', () => {
  it('把元素从一个位置移到另一个位置，不改原数组', () => {
    const src = ['a', 'b', 'c', 'd'];
    expect(moveItem(src, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(src, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(src).toEqual(['a', 'b', 'c', 'd']);
  });
  it('越界时原样返回', () => {
    expect(moveItem(['a'], 0, 5)).toEqual(['a']);
  });
});
