'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { LoadHeatmap } from '@/components/load-heatmap';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { groupByIteration, heatRows, upcomingWorkdays } from '@/features/gantt/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { ITERATION_STATUS_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import { useMembers, useMemberTasks, useOrg } from '@/lib/queries';
import type { MemberTasks } from '@/lib/types';

function WorkloadBody({ org, data }: { org: string; data: MemberTasks }) {
  const days = upcomingWorkdays(data.today, 4);
  const groups = groupByIteration(data.tasks);
  return (
    <div className="flex flex-col gap-4">
      <LoadHeatmap org={org} title="未来四周负载" days={days} {...heatRows(data.tasks, days)} today={data.today} />
      {groups.length === 0 && <p className="py-8 text-center text-muted-foreground">没有进行中的任务</p>}
      {groups.map((g) => (
        <section key={g.key} aria-label={g.iteration?.name ?? '不在迭代中'} className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            {g.iteration ? (
              <Link href={`/${org}/iterations/${g.iteration.id}?tab=gantt`} className="hover:underline">
                {g.iteration.name}
              </Link>
            ) : (
              '不在迭代中'
            )}
            {g.iteration && (
              <span className="text-xs font-normal text-muted-foreground">
                <span className="font-mono">
                  {g.iteration.startDate} ~ {g.iteration.endDate}
                </span>{' '}
                · {ITERATION_STATUS_LABEL[g.iteration.status]}
              </span>
            )}
          </h2>
          <div className="overflow-hidden rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>任务</TableHead>
                  <TableHead className="w-64">需求</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-44">开始 / 工期</TableHead>
                  <TableHead className="w-20 text-right">进度</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.tasks.map((t) => (
                  <TableRow key={t.id} className="h-10 even:bg-zebra">
                    <TableCell>
                      <Link href={`/${org}/tasks/${t.displayKey}`} className="mr-2 font-mono text-[12px] text-muted-foreground hover:underline">
                        {t.displayKey}
                      </Link>
                      {t.alias || t.title}
                    </TableCell>
                    <TableCell>
                      {t.requirement ? (
                        <Link href={`/${org}/requirements/${t.requirement.displayKey}`} className="hover:underline">
                          <span className="font-mono">{t.requirement.displayKey}</span> {t.requirement.title}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{TASK_STATUS_LABEL[t.status]}</TableCell>
                    <TableCell className="font-mono text-[13px]">
                      {t.planStart ?? '—'}
                      {t.planDays !== null && ` · ${t.planDays} 天`}
                    </TableCell>
                    <TableCell className="text-right font-mono">{t.progress}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
    </div>
  );
}

function WorkloadPage() {
  const { org } = useParams<{ org: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const memberId = params.get('member') ?? '';
  const includeFinished = params.get('all') === '1';
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const q = useMemberTasks(org, memberId, includeFinished);
  const people = members.data ? activePeople(members.data) : [];
  const go = (next: { member?: string; all?: boolean }) => {
    const sp = new URLSearchParams();
    const member = next.member ?? memberId;
    if (member) sp.set('member', member);
    if (next.all ?? includeFinished) sp.set('all', '1');
    router.replace(`/${org}/workload?${sp.toString()}`);
  };

  let body: ReactNode;
  if (!memberId) body = <p className="py-12 text-center text-muted-foreground">选择一位成员，查看他在各个迭代里的任务。</p>;
  else if (q.data) body = <WorkloadBody org={org} data={q.data} />;
  else if (q.isError) body = <QueryError error={q.error} noAccessMessage="成员不存在，或你没有查看权限。" retryMessage="加载任务失败，请重试。" onRetry={() => q.refetch()} />;
  else body = <Skeleton className="h-40" />;

  return (
    <>
      <PageHeader
        crumbs={[{ label: '迭代', href: `/${org}/iterations` }, { label: '人员负载' }]}
        title={q.data ? `${q.data.member.displayName} 的任务` : '人员负载'}
        description="跨迭代列出一个人负责的任务。默认只看规划中和进行中的迭代，以及不在迭代中的未完成任务。"
      />
      <div className="flex items-center gap-4">
        {people.length > 0 && (
          <MemberPicker label="选择成员" className="h-8 w-44" options={pickerOptions(people, null)} value={memberId || null} onChange={(id) => id && go({ member: id })} />
        )}
        <span className="flex items-center gap-2 text-[13px]">
          <Switch aria-label="包含已结束的迭代" checked={includeFinished} onCheckedChange={(v) => go({ all: v })} />
          包含已结束的迭代
        </span>
      </div>
      {body}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <WorkloadPage />
    </Suspense>
  );
}
