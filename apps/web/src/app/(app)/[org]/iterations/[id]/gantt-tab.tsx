'use client';

import { STARRED_LIMIT } from '@flower/core/schedule';
import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { LoadHeatmap } from '@/components/load-heatmap';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { heatRows, overviewIsHollow } from '@/features/gantt/model';
import { activePeople, canListMembers } from '@/features/members/model';
import { TASK_STATUS_LABEL } from '@/lib/labels';
import { api } from '@/lib/api';
import { taskMutationKeys, useApiMutation, useIterationGantt, useMembers, useOrg, useProducts } from '@/lib/queries';
import type { IterationGantt } from '@/lib/types';
import { TaskRow } from './task-row';
import { Timeline } from './timeline';

function OverviewStrip({ overview, taskCount }: { overview: IterationGantt['overview']; taskCount: number }) {
  const tiles = [
    { label: '整体进度', value: `${overview.overall}%` },
    { label: '理论进度', value: `${overview.expected}%` },
    { label: '落后', value: `${overview.behind}%` },
    { label: '遗留', value: `${overview.deferred} 项` },
  ];
  if (overviewIsHollow(overview, taskCount)) {
    return (
      <section aria-label="进度概览" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card px-3 py-2 text-[13px]">
        <span className="text-sm font-semibold">概览</span>
        <p className="text-muted-foreground">
          {taskCount === 0
            ? '添加任务并填写开始日期后，这里会汇总整体、理论、落后和遗留。'
            : '整体 0% · 理论 0% · 落后 0% · 遗留 0 项。填写开始日期后，进度会显示在任务表和时间轴。'}
        </p>
        {overview.attention.length > 0 && (
          <ul aria-label="关注与周知" className="flex min-w-full flex-col gap-1">
            {overview.attention.map((a) => (
              <li key={`${a.kind}-${a.title}`} className="flex flex-wrap items-center gap-2">
                <span className={a.kind === 'attention' ? 'font-medium text-destructive' : 'font-medium text-primary'}>{a.kind === 'attention' ? '关注' : '周知'}</span>
                <span>{a.title}</span>
                {a.assignees.length > 0 && <span className="text-muted-foreground">{a.assignees.join('、')}</span>}
                {a.note && <span className="text-muted-foreground">· {a.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  return (
    <section aria-label="进度概览" className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div key={t.label} role="group" aria-label={t.label} className="rounded-md border bg-card px-4 py-3">
            <div className="text-[12px] text-muted-foreground">{t.label}</div>
            <div className="font-mono text-lg font-semibold">{t.value}</div>
          </div>
        ))}
      </div>
      {overview.attention.length > 0 && (
        <ul aria-label="关注与周知" className="flex flex-col gap-1 rounded-md border bg-card px-4 py-2 text-[13px]">
          {overview.attention.map((a) => (
            <li key={`${a.kind}-${a.title}`} className="flex flex-wrap items-center gap-2">
              <span className={a.kind === 'attention' ? 'font-medium text-destructive' : 'font-medium text-primary'}>{a.kind === 'attention' ? '关注' : '周知'}</span>
              <span>{a.title}</span>
              {a.assignees.length > 0 && <span className="text-muted-foreground">{a.assignees.join('、')}</span>}
              {a.note && <span className="text-muted-foreground">· {a.note}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-muted-foreground">整体进度按需求平均；标了「关注」且未完成的需求记为遗留，不计入整体进度；理论进度按迭代已过的工作日计算。</p>
    </section>
  );
}

function AddTask({ org, gantt, onDone }: { org: string; gantt: IterationGantt; onDone: () => void }) {
  const products = useProducts(org);
  const choices = (products.data ?? []).filter((p) => gantt.editableProductIds.includes(p.id));
  const [title, setTitle] = useState('');
  const [productId, setProductId] = useState('');
  const picked = choices.find((p) => p.id === productId) ?? choices[0];
  const create = useApiMutation(
    () =>
      api(`/orgs/${org}/tasks`, {
        method: 'POST',
        body: { iterationId: gantt.iteration.id, title, productId: gantt.iteration.product ? undefined : picked?.id },
      }),
    { invalidate: taskMutationKeys(org), silentError: true, success: '已添加任务', onSuccess: onDone },
  );
  return (
    <form
      aria-label="新建任务"
      className="flex flex-col gap-2 rounded-md border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined);
      }}
    >
      <div className="flex items-center gap-2">
        {!gantt.iteration.product && choices.length > 1 && (
          <Select value={picked?.id} onValueChange={setProductId}>
            <SelectTrigger className="h-8 w-36" aria-label="所属产品">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          aria-label="新任务名称"
          placeholder="不挂需求的任务，例如：联调、埋点"
          className="h-8 max-w-sm"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
          添加
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
      <FormError error={create.error} />
    </form>
  );
}

export function GanttTab({ org, iterationId }: { org: string; iterationId: string }) {
  const q = useIterationGantt(org, iterationId);
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [adding, setAdding] = useState(false);
  if (!q.data) {
    if (q.isError) {
      return <QueryError error={q.error} noAccessMessage="迭代不存在，或你没有查看它的权限。" retryMessage="加载甘特失败，请重试。" onRetry={() => q.refetch()} />;
    }
    return <Skeleton className="h-64" />;
  }
  const g = q.data;
  const people = members.data ? activePeople(members.data) : null;
  return (
    <div className="flex flex-col gap-4">
      <OverviewStrip overview={g.overview} taskCount={g.tasks.length} />
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold">
          任务（{g.tasks.length}）
          <span className="font-mono text-xs font-normal text-muted-foreground">
            重点 {g.starredCount}/{STARRED_LIMIT}
          </span>
        </h2>
        {g.canAddTask && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            ＋ 任务
          </Button>
        )}
      </div>
      {adding && <AddTask org={org} gantt={g} onDone={() => setAdding(false)} />}
      {g.tasks.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">还没有任务</p>
      ) : (
        <>
        <ul aria-label="任务" className="divide-y rounded-md border bg-card md:hidden">
          {g.tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <Link href={`/${org}/tasks/${t.displayKey}`} className="min-w-0 flex-1 truncate hover:underline">
                {t.title}
              </Link>
              <span className="shrink-0">{TASK_STATUS_LABEL[t.status]}</span>
            </li>
          ))}
        </ul>
        <div className="hidden min-w-0 overflow-x-auto rounded-md border bg-card md:block">
          {/* 1280 展开侧栏后表卡约 974px。min-w 960 让主列落在可用宽里；更窄时这层 overflow 仍是安全阀。 */}
          <Table className="min-w-[960px] table-fixed [&_td]:px-1.5 [&_th]:px-1.5">
            <colgroup>
              <col className="w-10" />
              <col />
              <col className="w-24" />
              <col className="w-[5.5rem]" />
              <col className="w-[11.5rem]" />
              <col className="w-32" />
              <col className="w-[8.75rem]" />
              <col className="w-16" />
              <col className="w-10" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="sr-only">重点</span>
                </TableHead>
                <TableHead>需求 / 任务</TableHead>
                <TableHead>负责人</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>开始 / 工期（天）</TableHead>
                <TableHead>进度（%）</TableHead>
                <TableHead>标记 / 延期（天）</TableHead>
                <TableHead>说明</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.tasks.map((t) => (
                <TaskRow key={t.id} org={org} task={t} people={people} />
              ))}
            </TableBody>
          </Table>
        </div>
        </>
      )}
      <Timeline tasks={g.tasks} days={g.workdays} today={g.today} />
      <LoadHeatmap org={org} title="团队负载" days={g.workdays} {...heatRows(g.tasks, g.workdays)} today={g.today} />
    </div>
  );
}
