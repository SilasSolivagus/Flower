import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFieldOption, forkFieldForProduct, listFields, reorderFieldOptions, updateFieldOption } from '../src/definitions/fields';
import { getLevelNames, setOrgLevelNames, setProductLevelNames } from '../src/definitions/levels';
import type { Actor } from '../src/domain-types';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

const field = async (key: string, productId?: string) =>
  (await listFields(t.db, owner, { productId })).find((f) => f.key === key)!;

describe('字段字典', () => {
  it('增加选项、改名、停用、排序', async () => {
    const platform = await field('platform');
    const pc = await addFieldOption(t.db, owner, platform.id, { label: 'PC客户端', color: '#2563eb' });
    const web = await addFieldOption(t.db, owner, platform.id, { label: 'Web端' });
    expect(pc.key).toMatch(/^o_/);
    await updateFieldOption(t.db, owner, web.id, { label: '网页端', active: false });
    await reorderFieldOptions(t.db, owner, platform.id, [web.id, pc.id]);
    const after = await field('platform');
    expect(after.options.map((o) => [o.label, o.active])).toEqual([['网页端', false], ['PC客户端', true]]);
  });

  it('排序必须包含该字段的全部选项', async () => {
    const platform = await field('platform');
    await expect(reorderFieldOptions(t.db, owner, platform.id, [platform.options[0]!.id])).rejects.toMatchObject({ code: 'invalid' });
  });

  it('产品覆盖字段后，产品视图使用覆盖版本，组织视图不变', async () => {
    const org = await field('priority');
    const forked = await forkFieldForProduct(t.db, owner, productId, org.id);
    expect(forked.productId).toBe(productId);
    expect(forked.options.map((o) => o.key)).toEqual(['p0', 'p1', 'p2', 'p3']);
    await addFieldOption(t.db, owner, forked.id, { label: '绿色通道', key: 'green' });

    expect((await field('priority', productId)).options.map((o) => o.label)).toContain('绿色通道');
    expect((await field('priority')).options.map((o) => o.label)).not.toContain('绿色通道');
    await expect(forkFieldForProduct(t.db, owner, productId, org.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('普通成员不能改组织字典', async () => {
    const platform = await field('platform');
    await expect(addFieldOption(t.db, { ...owner, orgRole: 'member' }, platform.id, { label: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('结构树层级叫法', () => {
  it('默认值、组织设置、产品覆盖与清除', async () => {
    expect(await getLevelNames(t.db, owner)).toEqual({ names: ['业务域', '模块', '功能点'], source: 'org' });
    await setOrgLevelNames(t.db, owner, ['产品线', '能力']);
    expect(await getLevelNames(t.db, owner, productId)).toEqual({ names: ['产品线', '能力'], source: 'org' });
    await setProductLevelNames(t.db, owner, productId, ['模块']);
    expect(await getLevelNames(t.db, owner, productId)).toEqual({ names: ['模块'], source: 'product' });
    await setProductLevelNames(t.db, owner, productId, null);
    expect((await getLevelNames(t.db, owner, productId)).source).toBe('org');
  });

  it('层级数量与名称长度校验', async () => {
    await expect(setOrgLevelNames(t.db, owner, [])).rejects.toMatchObject({ code: 'invalid' });
    await expect(setOrgLevelNames(t.db, owner, ['a', 'b', 'c', 'd'])).rejects.toMatchObject({ code: 'invalid' });
    await expect(setOrgLevelNames(t.db, owner, ['这是一个超过十个字的层级名称'])).rejects.toMatchObject({ code: 'invalid' });
  });
});
