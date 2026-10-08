import { describe, expect, it } from 'vitest';
import { type PersonEntry, Resolver } from '../src/mapping';
import { buildImportPlan } from '../src/plan';
import { suggestMapping } from '../src/suggest';
import { makeLegacyData, messyLegacyData, planeReq } from './fixtures';

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

  it('suggest 对自身输出再运行一次，people 与第一次相同（幂等）', () => {
    const data = messyLegacyData();
    const first = suggestMapping(data, null);
    const second = suggestMapping(data, first);
    expect(second.people).toEqual(first.people);
  });

  it('两字短名同时匹配两个三字姓名的后两字时不合并', () => {
    const data = messyLegacyData();
    data.plane.requirements.push(planeReq({ id: 'X099', title: '另一个候选', owner: '王小雨', created_at: '2026-03-08T08:00:00Z' }));
    const m2 = suggestMapping(data, null);
    const r2 = new Resolver(m2);
    expect(r2.person('小雨')?.displayName).toBe('小雨');
    expect(r2.person('周小雨')?.displayName).toBe('周小雨');
    expect(r2.person('王小雨')?.displayName).toBe('王小雨');
  });
});

describe('人员对照表：同名的不同人', () => {
  const sameName = () => {
    const data = messyLegacyData();
    data.plane.users.push({ id: 'w1', email: 'wangwei1@example.com', name: '王伟', nickname: null, role: 'member', created_at: '2026-03-01 00:00:00' });
    data.plane.users.push({ id: 'w2', email: 'wangwei2@example.com', name: '王伟', nickname: null, role: 'member', created_at: '2026-03-01 00:00:00' });
    return data;
  };

  it('邮箱不同的两个同名账号保留为两个人；头衔写法有两个候选时不合并、也不改名成同名的第三个人', () => {
    const data = sameName();
    data.plane.requirements.push(planeReq({ id: 'X201', title: '同名测试', owner: '设计-王伟', created_at: '2026-03-08T08:00:00Z' }));
    const m = suggestMapping(data, null);
    const wangs = m.people.people.filter((p) => p.displayName === '王伟');
    expect(wangs.map((p) => p.email).sort()).toEqual(['wangwei1@example.com', 'wangwei2@example.com']);
    expect(wangs.every((p) => !p.aliases.includes('设计-王伟'))).toBe(true);
    expect(m.people.people.find((p) => p.aliases.includes('设计-王伟'))?.displayName).toBe('设计-王伟');
    expect(suggestMapping(data, m).people).toEqual(m.people);
  });

  it('导入时遇到多人共用的写法记为问题、拒绝写入，不替任何一方做主', () => {
    const data = sameName();
    data.plane.requirements.push(planeReq({ id: 'X202', title: '只写了名字', owner: '王伟', created_at: '2026-03-08T08:00:00Z' }));
    const plan = buildImportPlan(data, suggestMapping(data, null), {
      orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null,
    });
    expect(plan.report.problems).toContain('人员对照表中多人共用这个写法，无法判断是谁（请给其中一人改显示名或删去这个别名）：王伟');
  });
});

describe('人员对照表：多人写法与代签写法别名混合的旧条目', () => {
  it('旧版对照表里一个条目同时有多人写法别名和代签写法别名时整条删除', () => {
    const entry: PersonEntry = {
      key: 'p_old_mixed', displayName: '混合条目', email: null, orgRole: 'member', productRole: null,
      functionTags: [], aliases: ['王五、赵六', '代饶总 by 张三'], mentions: 2,
    };
    const old = suggestMapping(makeLegacyData(), null);
    old.people.people.push(entry);

    const m = suggestMapping(messyLegacyData(), old);
    const keys = m.people.people.map((p) => p.key);
    expect(keys).not.toContain('p_old_mixed');
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
