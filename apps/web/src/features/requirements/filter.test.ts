import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, filterToApiQuery, filterToSearch, parseFilter, patchFilter } from './filter';

describe('需求筛选条件', () => {
  it('从网址读取，缺省值不写回网址，写回的顺序固定', () => {
    const f = parseFilter(new URLSearchParams('product=PAN&state=collect,developing&priority=p1&q=%E4%B8%8B%E8%BD%BD&page=3'));
    expect(f).toEqual({ ...EMPTY_FILTER, product: 'PAN', states: ['collect', 'developing'], priority: ['p1'], q: '下载', page: 3 });
    expect(filterToSearch(f)).toBe('product=PAN&state=collect%2Cdeveloping&priority=p1&q=%E4%B8%8B%E8%BD%BD&page=3');
    expect(filterToSearch(EMPTY_FILTER)).toBe('');
    expect(parseFilter(new URLSearchParams('page=abc&sort=bogus'))).toEqual(EMPTY_FILTER);
  });

  it('转成接口查询参数：未排期用 noIteration，固定每页 50 条', () => {
    const q = filterToApiQuery({ ...EMPTY_FILTER, states: ['collect'], iteration: 'none', owner: 'm1', q: ' PAN-3 ' });
    expect(q).toBe('state=collect&owner=m1&noIteration=1&q=PAN-3&sort=updated&page=1&pageSize=50');
    expect(filterToApiQuery({ ...EMPTY_FILTER, iteration: 'it1', node: 'n1', platform: ['a', 'b'] })).toBe(
      'node=n1&platform=a%2Cb&iteration=it1&sort=updated&page=1&pageSize=50',
    );
  });

  it('改变筛选条件时页码回到第一页', () => {
    const f = { ...EMPTY_FILTER, page: 4 };
    expect(patchFilter(f, { priority: ['p0'] }).page).toBe(1);
    expect(patchFilter(f, { page: 5 }).page).toBe(5);
  });
});
