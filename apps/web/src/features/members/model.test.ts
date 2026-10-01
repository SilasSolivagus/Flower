import { describe, expect, it } from 'vitest';
import type { Invitation, Member } from '@/lib/types';
import { activePeople, canListMembers, filterMembers, filterPickerOptions, invitationState, memberKind, pickerOptions } from './model';

const m = (over: Partial<Member>): Member => ({
  id: 'x', kind: 'human', displayName: '成员', email: null, department: null, orgRole: 'member', status: 'active',
  hasAccount: true, functionTagIds: [], productRoles: [], ...over,
});
const all = [
  m({ id: '1', displayName: '林澄', email: 'lin@example.com', orgRole: 'owner' }),
  m({ id: '2', displayName: '王总', hasAccount: false, department: '商务部' }),
  m({ id: '3', displayName: 'PRD 助手', kind: 'agent', hasAccount: false }),
  m({ id: '4', displayName: '沈知', hasAccount: false, orgRole: 'guest', status: 'left' }),
];
const f = { query: '', kind: 'all' as const, role: 'all' as const, includeLeft: false };

describe('成员筛选', () => {
  it('区分账号、无账号、Agent', () => {
    expect(all.map(memberKind)).toEqual(['account', 'none', 'agent', 'none']);
  });
  it('默认隐藏已离开的成员', () => {
    expect(filterMembers(all, f).map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(filterMembers(all, { ...f, includeLeft: true })).toHaveLength(4);
  });
  it('按姓名、邮箱、部门搜索，不区分大小写', () => {
    expect(filterMembers(all, { ...f, query: 'LIN' }).map((x) => x.id)).toEqual(['1']);
    expect(filterMembers(all, { ...f, query: '商务' }).map((x) => x.id)).toEqual(['2']);
  });
  it('按类型与角色筛选', () => {
    expect(filterMembers(all, { ...f, kind: 'agent' }).map((x) => x.id)).toEqual(['3']);
    expect(filterMembers(all, { ...f, role: 'owner' }).map((x) => x.id)).toEqual(['1']);
  });
});

describe('可访问成员列表', () => {
  it('访客与未加载完成时不能查看', () => {
    expect(canListMembers(undefined)).toBe(false);
    expect(canListMembers({ memberId: 'm1', orgRole: 'guest' })).toBe(false);
    expect(canListMembers({ memberId: 'm1', orgRole: 'member' })).toBe(true);
  });
});

describe('可选为负责人的成员', () => {
  it('只保留在职真人', () => {
    expect(activePeople(all).map((x) => x.id)).toEqual(['1', '2']);
  });
});

describe('成员选择框', () => {
  const people = activePeople(all);

  it('当前值指向已离开的成员时保留在选项末尾', () => {
    expect(pickerOptions(people, { id: '4', displayName: '沈知' }).map((o) => o.id)).toEqual(['1', '2', '4']);
    expect(pickerOptions(people, { id: '1', displayName: '林澄' }).map((o) => o.id)).toEqual(['1', '2']);
    expect(pickerOptions(people, null)).toEqual([
      { id: '1', displayName: '林澄', email: 'lin@example.com', department: null },
      { id: '2', displayName: '王总', email: null, department: '商务部' },
    ]);
  });

  it('按姓名、邮箱、部门过滤，忽略大小写与空白；姓名以关键词开头的排在前面', () => {
    const opts = [
      { id: 'a', displayName: '王小林' },
      { id: 'b', displayName: '林澄', email: 'lin@example.com' },
      { id: 'c', displayName: '赵六', department: '林业部' },
      { id: 'd', displayName: '钱七' },
    ];
    expect(filterPickerOptions(opts, '林').map((o) => o.id)).toEqual(['b', 'a', 'c']);
    expect(filterPickerOptions(opts, ' LIN ').map((o) => o.id)).toEqual(['b']);
    expect(filterPickerOptions(opts, '')).toHaveLength(4);
    expect(filterPickerOptions(opts, '不存在')).toEqual([]);
  });
});

describe('邀请状态', () => {
  const inv = (over: Partial<Invitation>): Invitation => ({
    id: 'i', email: 'a@b.c', orgRole: 'member', memberId: null, expiresAt: '2099-01-01T00:00:00.000Z',
    acceptedAt: null, revokedAt: null, createdAt: '2026-01-01T00:00:00.000Z', ...over,
  });
  it('按接受、撤销、过期、待接受的优先级判断', () => {
    expect(invitationState(inv({ acceptedAt: '2026-01-02T00:00:00.000Z' }))).toBe('accepted');
    expect(invitationState(inv({ revokedAt: '2026-01-02T00:00:00.000Z' }))).toBe('revoked');
    expect(invitationState(inv({ expiresAt: '2020-01-01T00:00:00.000Z' }))).toBe('expired');
    expect(invitationState(inv({}))).toBe('pending');
  });
});
