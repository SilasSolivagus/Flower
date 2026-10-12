import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, members } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createAgentMember, createPlaceholderMember, listMembers, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { applyWecomImport, listMentionMembers, parseWecomCsv, previewWecomImport, setMemberWecomUserid, unbindMyWecom } from '../src/wecom/accounts';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let zhang: string;
let li: string;
let wang: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  zhang = (await createPlaceholderMember(t.db, owner, { displayName: '张三', email: 'zhang@example.com' })).id;
  li = (await createPlaceholderMember(t.db, owner, { displayName: '李四', email: 'li@example.com' })).id;
  wang = (await createPlaceholderMember(t.db, owner, { displayName: '王五', email: 'wang@example.com' })).id;
});
afterAll(() => t.cleanup());

describe('手动填写', () => {
  it('写入、清空、记事件；列表里能看到', async () => {
    expect(await setMemberWecomUserid(t.db, owner, zhang, ' zhangsan ')).toEqual({ memberId: zhang, wecomUserid: 'zhangsan' });
    expect((await listMembers(t.db, owner)).find((m) => m.id === zhang)!.wecomUserid).toBe('zhangsan');
    const [ev] = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.wecom_changed'));
    expect(ev!.payload).toMatchObject({ via: 'manual', changes: [{ field: 'wecomUserid', old: null, new: 'zhangsan' }] });
    expect((await setMemberWecomUserid(t.db, owner, li, 'lisi')).wecomUserid).toBe('lisi');
    expect((await setMemberWecomUserid(t.db, owner, li, '')).wecomUserid).toBeNull();
  });

  it('重复时报已绑定到谁；格式不对；Agent 不能绑定；只有组织管理员', async () => {
    await expect(setMemberWecomUserid(t.db, owner, li, 'zhangsan')).rejects.toThrow('该企业微信账号已绑定到 张三');
    await expect(setMemberWecomUserid(t.db, owner, li, '李四')).rejects.toThrow('企业微信账号格式不正确');
    const agent = await createAgentMember(t.db, owner, { displayName: '助手' });
    await expect(setMemberWecomUserid(t.db, owner, agent.id, 'bot')).rejects.toThrow('Agent 成员不能绑定企业微信账号');
    const member = await asMember(t.db, owner, '普通成员');
    await expect(setMemberWecomUserid(t.db, member, li, 'lisi')).rejects.toThrow('需要组织管理员权限');
  });

  it('成员自行解除；只读 Token 不能解除', async () => {
    await t.adminDb.update(members).set({ wecomUserid: 'owner-wx' }).where(eq(members.id, owner.memberId));
    await expect(unbindMyWecom(t.db, readOnlyToken(owner))).rejects.toThrow('只读 Token 不能解除企业微信绑定');
    await unbindMyWecom(t.db, owner);
    expect((await t.adminDb.select().from(members).where(eq(members.id, owner.memberId)))[0]!.wecomUserid).toBeNull();
  });
});

describe('CSV 导入', () => {
  it('CSV 解析容忍 Excel 导出格式：BOM、CRLF、表头、中文逗号、引号、空行', () => {
    const csv = '﻿邮箱,企业微信账号\r\n"Zhang@Example.com","zhangsan"\r\n\r\nli@example.com，lisi\r\nwang@example.com\twangwu\r\n';
    expect(parseWecomCsv(csv)).toEqual([
      { line: 2, email: 'zhang@example.com', userid: 'zhangsan' },
      { line: 4, email: 'li@example.com', userid: 'lisi' },
      { line: 5, email: 'wang@example.com', userid: 'wangwu' },
    ]);
    expect(parseWecomCsv('a@example.com,x\n')).toEqual([{ line: 1, email: 'a@example.com', userid: 'x' }]);
  });

  it('预览分类：无变化、可匹配、找不到成员、账号重复（已绑定他人 / 文件内重复）、格式不对', async () => {
    const csv = [
      'zhang@example.com,zhangsan',
      'li@example.com,lisi',
      'nobody@example.com,nobody',
      'wang@example.com,zhangsan',
      'wang@example.com,wangwu',
      'owner@example.com,lisi',
      'li@example.com,',
      'bad@example.com,有空格 的账号',
    ].join('\n');
    const r = await previewWecomImport(t.db, owner, csv);
    expect(r.rows.map((x) => x.status)).toEqual(['unchanged', 'ok', 'not_found', 'duplicate', 'ok', 'duplicate', 'invalid', 'invalid']);
    expect(r.rows[3]!.note).toBe('该企业微信账号已绑定到 张三');
    expect(r.rows[5]!.note).toBe('与第 2 行的企业微信账号重复');
    expect(r.counts).toEqual({ ok: 2, unchanged: 1, not_found: 1, duplicate: 2, invalid: 2 });
    expect(r.applied).toBe(0);
    expect((await listMembers(t.db, owner)).find((m) => m.id === li)!.wecomUserid).toBeNull();
  });

  it('确认导入只写可匹配的行，每人一条事件', async () => {
    const r = await applyWecomImport(t.db, owner, 'li@example.com,lisi\nwang@example.com,wangwu\nnobody@example.com,x');
    expect(r.applied).toBe(2);
    const all = await listMembers(t.db, owner);
    expect(all.find((m) => m.id === li)!.wecomUserid).toBe('lisi');
    expect(all.find((m) => m.id === wang)!.wecomUserid).toBe('wangwu');
    const imports = (await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.wecom_changed'))).filter((e) => e.payload.via === 'import');
    expect(imports).toHaveLength(2);
  });

  it('超过 2000 行拒绝；非组织管理员不能预览', async () => {
    const big = Array.from({ length: 2001 }, (_, i) => `u${i}@example.com,u${i}`).join('\n');
    await expect(previewWecomImport(t.db, owner, big)).rejects.toThrow('一次最多导入 2000 行');
    const member = await asMember(t.db, owner, '成员乙');
    await expect(previewWecomImport(t.db, member, 'a@example.com,a')).rejects.toThrow('需要组织管理员权限');
  });
});

describe('@ 候选成员', () => {
  it('含已离开成员；看不到产品的标出来；访客调用时不返回邮箱', async () => {
    await updateMember(t.db, owner, wang, { status: 'left' });
    const guest = await asMember(t.db, owner, '访客甲');
    await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
    const list = await listMentionMembers(t.db, owner, productId);
    expect(list.find((m) => m.id === zhang)).toEqual({ id: zhang, displayName: '张三', email: 'zhang@example.com', status: 'active', wecomBound: true, canSeeProduct: true });
    expect(list.find((m) => m.id === wang)).toMatchObject({ status: 'left', canSeeProduct: false });
    expect(list.find((m) => m.id === guest.memberId)).toMatchObject({ status: 'active', canSeeProduct: false });
    const asGuestViewer = { ...guest, orgRole: 'guest' as const };
    await expect(listMentionMembers(t.db, asGuestViewer, productId)).rejects.toThrow('产品不存在');
  });

  it('访客被授予产品角色后可调用，返回的候选成员都没有邮箱', async () => {
    const guest = await asMember(t.db, owner, '访客乙', 'guest');
    await setProductRole(t.db, owner, productId, guest.memberId, 'viewer');
    const list = await listMentionMembers(t.db, guest, productId);
    expect(list.length).toBeGreaterThan(1);
    expect(list.every((m) => m.email === null)).toBe(true);
    expect((await listMentionMembers(t.db, owner, productId)).some((m) => m.email !== null)).toBe(true);
  });
});
