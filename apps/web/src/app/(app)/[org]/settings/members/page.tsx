'use client';

import { Search, Users } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { filterMembers, invitationState, type MemberFilter, memberKind } from '@/features/members/model';
import { MEMBER_KIND_LABEL, ORG_ROLE_LABEL } from '@/lib/labels';
import { useFunctionTags, useInvitations, useMembers, useOrg } from '@/lib/queries';
import type { Member } from '@/lib/types';
import { InvitationsTab } from './invitations-tab';
import { InviteDialog } from './invite-dialog';
import { MemberDrawer } from './member-drawer';
import { PlaceholderDialog } from './placeholder-dialog';

const KIND_STYLE = {
  account: 'bg-accent text-accent-foreground',
  none: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  agent: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100',
} as const;

function MembersPage() {
  const { org } = useParams<{ org: string }>();
  const orgQ = useOrg(org);
  const members = useMembers(org);
  const tags = useFunctionTags(org);
  const invitations = useInvitations(org);
  const [filter, setFilter] = useState<MemberFilter>({ query: '', kind: 'all', role: 'all', includeLeft: false });
  const [selected, setSelected] = useState<Member | null>(null);
  const [inviting, setInviting] = useState<{ open: boolean; bindTo: Member | null }>({ open: false, bindTo: null });
  const [placeholder, setPlaceholder] = useState(false);
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const rows = filterMembers(members.data ?? [], filter);
  const pending = (invitations.data ?? []).filter((i) => invitationState(i) === 'pending').length;

  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '成员' }]}
        title="成员"
        description="无账号成员也可以被指派为提出人或负责人，之后发送邀请即可关联账号。"
        actions={
          <>
            <Button variant="outline" onClick={() => setPlaceholder(true)}>
              登记无账号成员
            </Button>
            <Button onClick={() => setInviting({ open: true, bindTo: null })}>邀请成员</Button>
          </>
        }
      />
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">成员 {members.data?.filter((m) => m.status === 'active').length ?? ''}</TabsTrigger>
          <TabsTrigger value="invitations">待接受邀请 {pending}</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="flex h-9 w-72 items-center gap-2 rounded-md border bg-card px-3 text-muted-foreground">
              <Search className="size-4" aria-hidden="true" />
              <Input
                className="h-8 border-0 p-0 shadow-none focus-visible:ring-0"
                placeholder="搜索姓名、邮箱或部门"
                value={filter.query}
                onChange={(e) => setFilter({ ...filter, query: e.target.value })}
              />
            </label>
            <Select value={filter.kind} onValueChange={(v) => setFilter({ ...filter, kind: v as MemberFilter['kind'] })}>
              <SelectTrigger className="w-32" aria-label="按类型筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="account">账号</SelectItem>
                <SelectItem value="none">无账号</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filter.role} onValueChange={(v) => setFilter({ ...filter, role: v as MemberFilter['role'] })}>
              <SelectTrigger className="w-32" aria-label="按角色筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部角色</SelectItem>
                {(['owner', 'admin', 'member', 'guest'] as const).map((r) => (
                  <SelectItem key={r} value={r}>
                    {ORG_ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1.5 text-[13px]">
              <Checkbox checked={filter.includeLeft} onCheckedChange={(v) => setFilter({ ...filter, includeLeft: v === true })} />
              含已离开
            </label>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={Users} title="没有符合条件的成员" />
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>成员</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>组织角色</TableHead>
                    <TableHead>职能</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => {
                    const kind = memberKind(m);
                    return (
                      <TableRow key={m.id} className="h-10 even:bg-zebra">
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{m.displayName}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {m.email ?? (m.department ? `${m.department} · 未关联账号` : kind === 'agent' ? 'API 调用身份' : '—')}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`border-0 ${KIND_STYLE[kind]}`}>
                            {MEMBER_KIND_LABEL[kind]}
                          </Badge>
                        </TableCell>
                        <TableCell>{ORG_ROLE_LABEL[m.orgRole]}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {m.functionTagIds.map((id) => {
                              const t = tagById.get(id);
                              return t ? (
                                <span key={id} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                                  <span className="size-1.5 rounded-full" style={{ background: t.color }} />
                                  {t.name}
                                </span>
                              ) : null;
                            })}
                          </div>
                        </TableCell>
                        <TableCell className={m.status === 'left' ? 'text-muted-foreground' : 'text-emerald-700 dark:text-emerald-400'}>
                          {m.status === 'left' ? '已离开' : '在职'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" aria-label={`查看${m.displayName}`} onClick={() => setSelected(m)}>
                            详情
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="invitations">
          <InvitationsTab org={org} />
        </TabsContent>
      </Tabs>
      {orgQ.data && (
        <MemberDrawer
          org={org}
          me={orgQ.data.me}
          member={selected}
          onOpenChange={(v) => !v && setSelected(null)}
          onInvite={(m) => {
            setSelected(null);
            setInviting({ open: true, bindTo: m });
          }}
        />
      )}
      <InviteDialog
        key={inviting.bindTo?.id ?? 'new'}
        org={org}
        open={inviting.open}
        bindTo={inviting.bindTo}
        onOpenChange={(v) => setInviting({ open: v, bindTo: v ? inviting.bindTo : null })}
      />
      <PlaceholderDialog org={org} open={placeholder} onOpenChange={setPlaceholder} />
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <MembersPage />
    </RequireOrgAdmin>
  );
}
