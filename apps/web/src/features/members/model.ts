import type { Invitation, Member, OrgMe, OrgRole } from '@/lib/types';

export type MemberFilter = { query: string; kind: 'all' | 'account' | 'none' | 'agent'; role: 'all' | OrgRole; includeLeft: boolean };

export function memberKind(m: Member): 'account' | 'none' | 'agent' {
  if (m.kind === 'agent') return 'agent';
  return m.hasAccount ? 'account' : 'none';
}

/** 访客不能查看成员列表；`me` 未加载完成前也视为不能。 */
export function canListMembers(me: OrgMe | undefined): boolean {
  return !!me && me.orgRole !== 'guest';
}

/** 可选为负责人/阻塞项负责人等的在职真人成员。 */
export function activePeople(members: Member[]): Member[] {
  return members.filter((m) => m.status === 'active' && m.kind === 'human');
}

/** 旧验收种子显示名。只改用户看见的字，不改库里的字段名。 */
export function scrubLegacyDisplayName(name: string): string {
  return name.replaceAll('决策人（测试）', '确认人（测试）');
}

export type PickerOption = { id: string; displayName: string; email?: string | null; department?: string | null };

/** 成员选择框的选项：传入的成员；当前值指向不在列表里的成员（例如已离开）时追加在末尾，保证能显示出来。 */
export function pickerOptions(people: Member[], current: { id: string; displayName: string } | null): PickerOption[] {
  const list: PickerOption[] = people.map((p) => ({ id: p.id, displayName: scrubLegacyDisplayName(p.displayName), email: p.email, department: p.department }));
  return current && !list.some((o) => o.id === current.id) ? [...list, { id: current.id, displayName: scrubLegacyDisplayName(current.displayName) }] : list;
}

/** 按姓名、邮箱、部门过滤，忽略大小写与空白；姓名以关键词开头的排在前面，其余保持原顺序。 */
export function filterPickerOptions(options: PickerOption[], query: string): PickerOption[] {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase();
  const q = norm(query);
  if (!q) return options;
  const matched = options.filter((o) => [o.displayName, o.email, o.department].some((s) => norm(s).includes(q)));
  const starts = (o: PickerOption) => norm(o.displayName).startsWith(q);
  return [...matched.filter(starts), ...matched.filter((o) => !starts(o))];
}

export function filterMembers(members: Member[], f: MemberFilter): Member[] {
  const q = f.query.trim().toLowerCase();
  return members.filter((m) => {
    if (!f.includeLeft && m.status === 'left') return false;
    if (f.kind !== 'all' && memberKind(m) !== f.kind) return false;
    if (f.role !== 'all' && m.orgRole !== f.role) return false;
    if (!q) return true;
    return [scrubLegacyDisplayName(m.displayName), m.email ?? '', m.department ?? ''].some((s) => s.toLowerCase().includes(q));
  });
}

export function invitationState(i: Invitation, now: Date = new Date()): 'pending' | 'expired' | 'accepted' | 'revoked' {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (new Date(i.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}
