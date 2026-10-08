import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMapping, Resolver, writeMapping } from '../src/mapping';
import { suggestMapping } from '../src/suggest';
import { makeLegacyData } from './fixtures';

describe('建议对照表', () => {
  const m = suggestMapping(makeLegacyData(), null);
  const r = new Resolver(m);

  it('有账号的人按邮箱合并，名字与邮箱都能解析到同一人', () => {
    const zs = r.person('张三');
    expect(zs).toMatchObject({ email: 'zhangsan@example.com', orgRole: 'admin' });
    expect(r.person('zhangsan@example.com')?.key).toBe(zs!.key);
    expect(r.person('王老板')).toMatchObject({ orgRole: 'member', productRole: 'viewer' });
  });

  it('没有账号的人按名字建为成员，并按出现位置建议职能标签', () => {
    expect(r.person('王五')).toMatchObject({ email: null, functionTags: ['开发'] });
    expect(r.person('客户丙')).toMatchObject({ email: null, functionTags: [] });
    expect(r.person('李四')?.functionTags).toEqual(expect.arrayContaining(['产品经理', '设计']));
  });

  it('代签写法拆成会签角色和实际操作人，会签角色先建为占位成员', () => {
    expect(m.people.signoffRoles['饶总']).toBeDefined();
    expect(r.signoffRole('饶总')?.displayName).toBe('饶总');
  });

  it('平台按已知写法归并，未知写法建议为新选项，"全端"展开为全部平台', () => {
    expect(r.platforms('web')).toEqual(['web']);
    expect(r.platforms('PC客户端')).toEqual(['pc']);
    expect(r.platforms('全端')).toEqual(['pc', 'mobile', 'web', 'mini']);
    const harmony = r.platforms('鸿蒙');
    expect(harmony).toHaveLength(1);
    expect(m.platforms.options.find((o) => o.key === harmony[0])?.label).toBe('鸿蒙');
  });

  it('业务域：PRD 的业务域在前，每个原始写法先各自成为一个节点', () => {
    expect(m.domains.nodes.map((n) => n.name)).toEqual(['会员与支付', '跨盘迁移', '会员']);
    expect(m.domains.nodes[0]!.description).toBe('产品域 · 增长组');
    expect(r.domain('会员')).toBe('会员');
  });

  it('迭代：日期完全相同的合并，发布日相差不超过一天的与 push 迭代配对，与常规迭代重叠的 push 迭代建议为专项', () => {
    const its = m.iterations.iterations;
    expect(its).toHaveLength(3);
    expect(its.find((i) => i.planeIds.includes('V1'))).toMatchObject({ name: 'it0316', planeIds: ['V1', 'V1dup'], pushIds: ['it0316'], type: 'regular' });
    expect(its.find((i) => i.planeIds.includes('V2'))).toMatchObject({ pushIds: ['it0330'], type: 'regular' });
    expect(its.find((i) => i.pushIds.includes('sp1'))).toMatchObject({ name: '专项', type: 'special', planeIds: [] });
    expect(r.iteration('plane', 'V1dup')?.name).toBe('it0316');
  });

  it('解析不到的原始值会被记下', () => {
    expect(r.person('查无此人')).toBeNull();
    expect(r.platforms('火星端')).toEqual([]);
    expect(r.iteration('push', 'nope')).toBeNull();
    expect([...r.unmapped.people]).toContain('查无此人');
    expect([...r.unmapped.platforms]).toContain('火星端');
    expect([...r.unmapped.iterations]).toContain('push:nope');
  });
  it('多人写法按人解析；代签写法按实际操作人解析并计数', () => {
    const r2 = new Resolver(m);
    expect(r2.people('王五、李四').map((p) => p.displayName)).toEqual(['王五', '李四']);
    expect(r2.people('王五 李四').map((p) => p.displayName)).toEqual(['王五', '李四']);
    expect(r2.person('李四、王五')?.displayName).toBe('李四');
    expect(r2.people('代饶总 by 张三').map((p) => p.displayName)).toEqual(['张三']);
    expect([...r2.proxies]).toEqual([['代饶总 by 张三', 1]]);
    expect(r2.people('王五、查无此人').map((p) => p.displayName)).toEqual(['王五']);
    expect([...r2.unmapped.people]).toEqual(['查无此人']);
  });

  it('代签写法的实际操作人是多人写法时按人拆开，代签只计一次', () => {
    const r3 = new Resolver(m);
    expect(r3.people('代饶总 by 张三、李四').map((p) => p.displayName)).toEqual(['张三', '李四']);
    expect([...r3.proxies]).toEqual([['代饶总 by 张三、李四', 1]]);
  });
});

describe('迭代 ignore 列表', () => {
  it('ignore 列表中的引用返回 null，不计入 unmapped，计入 ignoredIterationRefs', () => {
    const m = suggestMapping(makeLegacyData(), null);
    m.iterations.ignore = ['plane:VTEST'];
    const r = new Resolver(m);
    expect(r.iteration('plane', 'VTEST')).toBeNull();
    expect([...r.unmapped.iterations]).not.toContain('plane:VTEST');
    expect(r.ignoredIterationRefs).toBe(1);
  });
});

describe('对照表文件', () => {
  it('写入后读回；已有条目在重新生成时保留用户的修改', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flower-mapping-'));
    expect(readMapping(dir)).toBeNull();
    const m = suggestMapping(makeLegacyData(), null);
    m.people.people.find((p) => p.displayName === '王五')!.displayName = '王五（后端）';
    m.domains.nodes = [{ name: '会员与支付', description: null, aliases: ['会员与支付', '会员'] }, { name: '跨盘迁移', description: null, aliases: ['跨盘迁移'] }];
    writeMapping(dir, m);
    const again = suggestMapping(makeLegacyData(), readMapping(dir));
    expect(again.people.people.find((p) => p.aliases.includes('王五'))?.displayName).toBe('王五（后端）');
    expect(again.domains.nodes.map((n) => n.name)).toEqual(['会员与支付', '跨盘迁移']);
    expect(new Resolver(again).domain('会员')).toBe('会员与支付');
  });

  it('已有的 ignore 列表在重新生成时保留', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flower-mapping-'));
    const m = suggestMapping(makeLegacyData(), null);
    m.iterations.ignore = ['plane:VTEST'];
    writeMapping(dir, m);
    const again = suggestMapping(makeLegacyData(), readMapping(dir));
    expect(again.iterations.ignore).toEqual(['plane:VTEST']);
  });
});
