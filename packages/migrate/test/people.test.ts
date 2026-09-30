import { describe, expect, it } from 'vitest';
import { type PersonEntry, Resolver } from '../src/mapping';
import { suggestMapping } from '../src/suggest';
import { makeLegacyData, messyLegacyData } from './fixtures';

describe('人员对照表：多人写法、头衔与昵称、非人员写法', () => {
  const m = suggestMapping(messyLegacyData(), null);
  const r = new Resolver(m);
  const names = m.people.people.map((p) => p.displayName);

  it('多人写法不建成一个人；拆出的新名字单独建为成员，并按出现位置建议职能标签', () => {
    expect(names.filter((n) => /[、,，/;；]/.test(n) || /\p{Script=Han}\s+\p{Script=Han}/u.test(n))).toEqual([]);
    expect(r.person('钱七')).toMatchObject({ displayName: '钱七', kind: 'human', functionTags: ['开发'] });
  });

  it('头衔与昵称写法并入本人，昵称成为别名', () => {
    const lisi = r.person('李四')!;
    expect(r.person('产品经理-李四(小李)')?.key).toBe(lisi.key);
    expect(r.person('小李')?.key).toBe(lisi.key);
    expect(names).not.toContain('产品经理-李四(小李)');
    expect(names).not.toContain('小李');
  });

  it('只有头衔写法、没有本名条目时改用姓名作显示名', () => {
    expect(r.person('运营-孙八')?.displayName).toBe('孙八');
    expect(r.person('孙八')?.displayName).toBe('孙八');
  });

  it('两字短名并入唯一的三字姓名；邮箱前缀并入该邮箱的人', () => {
    expect(r.person('小雨')?.displayName).toBe('周小雨');
    expect(r.person('lisi')?.displayName).toBe('李四');
  });

  it('代签写法只算实际操作人，不建成员；工具名建为 Agent，不给职能标签', () => {
    expect(names.filter((n) => n.startsWith('代'))).toEqual([]);
    expect(r.person('data-sync')).toMatchObject({ kind: 'agent', functionTags: [] });
    expect(r.person('model-v4-flash')).toMatchObject({ kind: 'agent', functionTags: [] });
    expect(r.person('张三')?.kind).toBe('human');
  });
});

describe('人员对照表：读取旧版对照表', () => {
  const entry = (key: string, displayName: string, over: Partial<PersonEntry> = {}): PersonEntry => ({
    key, displayName, email: null, orgRole: 'member', productRole: null, functionTags: ['开发'], aliases: [displayName], mentions: 1, ...over,
  });

  it('删掉旧版的多人条目、合并头衔条目；标了 keep 的条目与用户改过的显示名保留', () => {
    const old = suggestMapping(makeLegacyData(), null);
    old.people.people.push(entry('p_old_team', '王五、赵六'), entry('p_old_kept', '王五、钱七', { keep: true }), entry('p_old_title', '产品经理-李四(小李)', { functionTags: [] }));
    // 旧版对照表没有 kind 字段
    for (const p of old.people.people) delete p.kind;
    old.people.people.find((p) => p.displayName === '王五')!.displayName = '王五（后端）';

    const m = suggestMapping(messyLegacyData(), old);
    const r = new Resolver(m);
    const keys = m.people.people.map((p) => p.key);
    expect(keys).not.toContain('p_old_team');
    expect(keys).toContain('p_old_kept');
    expect(keys).not.toContain('p_old_title');
    expect(r.person('王五、钱七')?.key).toBe('p_old_kept');
    expect(r.person('产品经理-李四(小李)')?.displayName).toBe('李四');
    expect(r.person('王五')?.displayName).toBe('王五（后端）');
    expect(m.people.people.every((p) => p.kind === 'human' || p.kind === 'agent')).toBe(true);
    expect(m.people.signoffRoles).toEqual(old.people.signoffRoles);
  });

  it('删掉旧版把代签写法整体建成的条目；标了 keep 的保留', () => {
    const old = suggestMapping(makeLegacyData(), null);
    old.people.people.push(entry('p_old_proxy', '代饶总 by 张三', { functionTags: [] }), entry('p_old_proxy_kept', '代饶总 by 李四', { keep: true }));

    const m = suggestMapping(messyLegacyData(), old);
    const keys = m.people.people.map((p) => p.key);
    expect(keys).not.toContain('p_old_proxy');
    expect(keys).toContain('p_old_proxy_kept');
    expect(m.people.people.filter((p) => !p.keep && p.displayName.startsWith('代'))).toEqual([]);
  });
});
