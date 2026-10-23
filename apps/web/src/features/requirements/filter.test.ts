import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  effectiveRelatedScope,
  filterToApiQuery,
  filterToSearch,
  parseFilter,
  patchFilter,
  readRelatedScope,
  RELATED_SCOPE_KEY,
  requirementFilterActive,
  writeRelatedScope,
} from './filter';

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

  it('列表范围：我的只传 related=me，全部才传 owner，两者不同时出现', () => {
    const mine = filterToApiQuery({ ...EMPTY_FILTER, owner: 'm1', states: ['collect'] }, 50, 'me');
    expect(mine).toBe('state=collect&related=me&sort=updated&page=1&pageSize=50');
    expect(mine).not.toContain('owner=');
    const all = filterToApiQuery({ ...EMPTY_FILTER, owner: 'm1' }, 50, 'all');
    expect(all).toBe('owner=m1&sort=updated&page=1&pageSize=50');
    expect(all).not.toContain('related=');
    expect(filterToApiQuery(EMPTY_FILTER, 50, 'me')).toContain('related=me');
  });

  it('有负责人筛选时按全部查，避免和 related=me 冲突', () => {
    expect(effectiveRelatedScope('me', null)).toBe('me');
    expect(effectiveRelatedScope('me', 'm1')).toBe('all');
    expect(effectiveRelatedScope('all', 'm1')).toBe('all');
    expect(effectiveRelatedScope('all', null)).toBe('all');
  });

  it('需求范围只记在 localStorage，缺省和脏值都是我的', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(RELATED_SCOPE_KEY).toBe('flower.req.relatedScope');
    expect(readRelatedScope(null)).toBe('me');
    expect(readRelatedScope(storage)).toBe('me');
    writeRelatedScope(storage, 'all');
    expect(store.get(RELATED_SCOPE_KEY)).toBe('all');
    expect(readRelatedScope(storage)).toBe('all');
    writeRelatedScope(storage, 'me');
    expect(readRelatedScope(storage)).toBe('me');
    store.set(RELATED_SCOPE_KEY, 'bogus');
    expect(readRelatedScope(storage)).toBe('me');
    expect(readRelatedScope({ getItem: () => { throw new Error('blocked'); } })).toBe('me');
    expect(() => writeRelatedScope({ setItem: () => { throw new Error('blocked'); } }, 'all')).not.toThrow();
  });

  it('只有产品或排序时不算已筛选', () => {
    expect(requirementFilterActive(EMPTY_FILTER)).toBe(false);
    expect(requirementFilterActive({ ...EMPTY_FILTER, product: 'PAN', sort: 'number' })).toBe(false);
    expect(requirementFilterActive({ ...EMPTY_FILTER, states: ['backlog'] })).toBe(true);
    expect(requirementFilterActive({ ...EMPTY_FILTER, q: '  ' })).toBe(false);
    expect(requirementFilterActive({ ...EMPTY_FILTER, page: 2 })).toBe(true);
  });
});
