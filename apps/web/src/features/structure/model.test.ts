import { describe, expect, it } from 'vitest';
import type { StructureNode } from '@/lib/types';
import { flattenTree, nodeOptions } from './model';

const n = (id: string, parentId: string | null, depth: number, sort: number, status: 'active' | 'deprecated' = 'active'): StructureNode => ({
  id,
  parentId,
  depth,
  name: id,
  description: null,
  status,
  sort,
});

const nodes = [n('存储', null, 1, 1), n('会员', null, 1, 0), n('续费', '会员', 2, 1), n('开通', '会员', 2, 0), n('自动续费', '续费', 3, 0)];

describe('结构树模型', () => {
  it('先序展开：同级按 sort 排序', () => {
    expect(flattenTree(nodes).map((x) => x.id)).toEqual(['会员', '开通', '续费', '自动续费', '存储']);
  });

  it('节点下拉隐藏已停用节点及其下级，当前选中的保留', () => {
    const withDeprecated = nodes.map((x) => (x.id === '续费' ? { ...x, status: 'deprecated' as const } : x));
    expect(nodeOptions(withDeprecated, null).map((x) => x.id)).toEqual(['会员', '开通', '存储']);
    expect(nodeOptions(withDeprecated, '自动续费').map((x) => [x.id, x.depth])).toEqual([
      ['会员', 1],
      ['开通', 2],
      ['自动续费', 3],
      ['存储', 1],
    ]);
    expect(nodeOptions(withDeprecated, '续费').find((x) => x.id === '续费')).toMatchObject({ deprecated: true });
  });
});
