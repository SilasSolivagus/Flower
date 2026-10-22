'use client';

import { ListTodo } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMemberTasks, useOrg } from '@/lib/queries';
import { TASK_STATUS_LABEL } from '@/lib/labels';

export default function TasksPage() {
  const { org } = useParams<{ org: string }>();
  const orgQ = useOrg(org);
  const memberId = orgQ.data?.me.memberId ?? '';
  const q = useMemberTasks(org, memberId, true);

  return (
    <>
      <PageHeader
        crumbs={[{ label: '工作台', href: `/${org}` }, { label: '我的任务' }]}
        title="我的任务"
        description="指派给当前账号的任务，含已完成。排期请回迭代甘特修改。"
      />
      {!memberId || !q.data ? (
        q.isError ? (
          <QueryError error={q.error} noAccessMessage="无法读取任务。" retryMessage="加载任务失败，请重试。" onRetry={() => q.refetch()} />
        ) : (
          <Skeleton className="h-64" />
        )
      ) : q.data.tasks.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="还没有指派给你的任务"
          description="到迭代甘特里创建任务并指派给你。"
          action={
            <Button variant="outline" asChild>
              <Link href={`/${org}/iterations`}>去迭代</Link>
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <Table aria-label="我的任务" className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead className="hidden w-28 md:table-cell">编号</TableHead>
                <TableHead>标题</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="hidden w-20 md:table-cell">进度</TableHead>
                <TableHead className="hidden md:table-cell">所属迭代</TableHead>
                <TableHead className="hidden md:table-cell">关联需求</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.tasks.map((t) => (
                <TableRow key={t.id} className="h-10 even:bg-zebra">
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{t.displayKey}</TableCell>
                  <TableCell>
                    <Link href={`/${org}/tasks/${t.displayKey}`} className="block truncate hover:underline">
                      {t.title}
                    </Link>
                  </TableCell>
                  <TableCell>{TASK_STATUS_LABEL[t.status]}</TableCell>
                  <TableCell className="hidden font-mono md:table-cell">{t.progress}%</TableCell>
                  <TableCell className="hidden md:table-cell">{t.iteration?.name ?? '—'}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {t.requirement ? (
                      <Link href={`/${org}/requirements/${t.requirement.displayKey}`} className="font-mono text-xs hover:underline">
                        {t.requirement.displayKey}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
