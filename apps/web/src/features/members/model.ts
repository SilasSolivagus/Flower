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

export function filterMembers(members: Member[], f: MemberFilter): Member[] {
  const q = f.query.trim().toLowerCase();
  return members.filter((m) => {
    if (!f.includeLeft && m.status === 'left') return false;
    if (f.kind !== 'all' && memberKind(m) !== f.kind) return false;
    if (f.role !== 'all' && m.orgRole !== f.role) return false;
    if (!q) return true;
    return [m.displayName, m.email ?? '', m.department ?? ''].some((s) => s.toLowerCase().includes(q));
  });
}

export function invitationState(i: Invitation, now: Date = new Date()): 'pending' | 'expired' | 'accepted' | 'revoked' {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (new Date(i.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}
