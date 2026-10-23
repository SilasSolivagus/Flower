'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import type { Workbench } from '@/lib/types';
import { iterationGanttHref, iterationHref, iterationsHref, nowIterationDetailSubtitle, nowIterationEmptyKind, nowIterationSubtitle, nowIterationTaskHref, openNowIterationId } from './model';
import { type NowField, nowFieldShown, nowLayoutHasFoldedFields, type PersonaLayout, type WorkbenchPersona } from './persona';

type Item = Workbench['nowIterations'][number];

export function NowIterationBlock({ org, workbench, layout, persona }: { org: string; workbench: Workbench; layout: PersonaLayout; persona: WorkbenchPersona }) {
  const headingId = useId();
  const items = workbench.nowIterations;
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const openId = openNowIterationId(
    chosen,
    items.map((item) => item.id),
  );
  const empty = nowIterationEmptyKind(workbench.nowIterationPresence);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-sm font-semibold">
        此刻迭代
      </h2>
      {empty ? (
        <EmptyNow org={org} kind={empty} hint={workbench.planningHint} />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          {items.map((item) => (
            <NowIterationRow key={item.id} org={org} item={item} open={item.id === openId} onToggle={() => setChosen(item.id === openId ? null : item.id)} layout={layout} persona={persona} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyNow({ org, kind, hint }: { org: string; kind: 'none' | 'no_now'; hint: Workbench['planningHint'] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed bg-muted/60 px-4 py-2 text-[13px]">
      <p>{kind === 'none' ? '还没有迭代。' : '今天没有进行中、且起止日期包含今天的迭代。'}</p>
      <Link href={iterationsHref(org)} className="text-primary hover:underline">
        {kind === 'none' ? '查看迭代' : '查看全部迭代'}
      </Link>
      {kind === 'no_now' && hint ? (
        <Link href={iterationHref(org, hint.id)} className="text-primary hover:underline">
          规划中：{hint.name}
        </Link>
      ) : null}
    </div>
  );
}

function NowIterationRow({ org, item, open, onToggle, layout, persona }: { org: string; item: Item; open: boolean; onToggle: () => void; layout: PersonaLayout; persona: WorkbenchPersona }) {
  const panelId = useId();
  const status = ITERATION_STATUS_LABEL[item.status];
  const subtitle = nowIterationSubtitle(item);
  return (
    <li>
      <div className="flex h-10 min-w-0 items-center gap-3 overflow-hidden px-4 text-[13px]">
        <Link href={iterationHref(org, item.id)} title={item.name} className="min-w-0 flex-1 truncate font-medium hover:underline">
          {item.name}
        </Link>
        <span className="hidden min-w-0 max-w-[40%] truncate text-xs text-muted-foreground md:inline" title={subtitle}>
          {subtitle}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          需求 {item.doneCount}/{item.requirementCount}
        </span>
        <button type="button" className="shrink-0 text-primary hover:underline" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`${open ? '收起' : '展开'} ${item.name}`} onClick={onToggle}>
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open ? <NowIterationDetail key={persona} id={panelId} org={org} item={item} subtitle={nowIterationDetailSubtitle(item, status)} layout={layout} /> : null}
    </li>
  );
}

function NowIterationDetail({ id, org, item, subtitle, layout }: { id: string; org: string; item: Item; subtitle: string; layout: PersonaLayout }) {
  const [revealed, setRevealed] = useState(false);
  const show = (field: NowField) => nowFieldShown(layout, field, revealed);
  const overview = item.overview;
  const folded = nowLayoutHasFoldedFields(layout);
  return (
    <div id={id} className="flex flex-col gap-2 border-t bg-muted/20 px-4 py-2 text-[13px]">
      {show('subtitle') ? <p className="text-muted-foreground">{subtitle}</p> : null}
      {show('milestones') && item.milestoneSummary.total > 0 ? (
        <p className="text-muted-foreground">
          里程碑 {item.milestoneSummary.past} 已过 · {item.milestoneSummary.upcoming} 未到
          {item.milestoneSummary.next ? ` · 下一里程碑 ${item.milestoneSummary.next.label} ${item.milestoneSummary.next.date}` : ''}
        </p>
      ) : null}
      {show('overview') ? <OverviewLine org={org} item={item} /> : null}
      {show('attention') && overview && overview.attention.length > 0 ? (
        <ul aria-label="关注与周知" className="flex flex-col gap-1">
          {overview.attention.map((a) => (
            <li key={`${a.kind}-${a.title}`} className="flex flex-wrap items-center gap-2">
              <span className={a.kind === 'attention' ? 'font-medium text-destructive' : 'font-medium text-primary'}>{a.kind === 'attention' ? '关注' : '周知'}</span>
              <span>{a.title}</span>
              {a.assignees.length > 0 ? <span className="text-muted-foreground">{a.assignees.join('、')}</span> : null}
              {a.note ? <span className="text-muted-foreground">· {a.note}</span> : null}
            </li>
          ))}
          {overview.attentionTruncated ? <li className="text-xs text-muted-foreground">还有更多关注与周知</li> : null}
        </ul>
      ) : null}
      {show('blockers') && item.blockerCount > 0 ? <p>活跃阻塞 {item.blockerCount}</p> : null}
      {show('myTasks') ? <MyTasks org={org} item={item} /> : null}
      {layout.externalHint ? (
        <p data-slot="external-pending" className="text-xs text-muted-foreground">
          {layout.externalHint}
        </p>
      ) : null}
      {folded ? (
        <button type="button" className="self-start text-primary hover:underline" aria-expanded={revealed} onClick={() => setRevealed((value) => !value)}>
          {revealed ? '收起次要' : '显示次要'}
        </button>
      ) : null}
      <p className="flex flex-wrap gap-3">
        <Link href={iterationHref(org, item.id)} className="text-primary hover:underline">
          打开迭代
        </Link>
        <Link href={iterationGanttHref(org, item.id)} className="text-primary hover:underline">
          甘特
        </Link>
      </p>
    </div>
  );
}

function OverviewLine({ org, item }: { org: string; item: Item }) {
  const overview = item.overview;
  if (!overview || overview.isHollow) {
    const taskCount = overview?.taskCount ?? 0;
    return (
      <p className="text-muted-foreground">
        {taskCount === 0 ? '添加任务并填写开始日期后，这里会汇总整体、理论、落后和遗留。' : '整体 0% · 理论 0% · 落后 0% · 遗留 0 项。填写开始日期后，进度会显示在甘特。'}
        <Link href={iterationGanttHref(org, item.id)} className="ml-2 text-primary hover:underline">
          去甘特
        </Link>
      </p>
    );
  }
  return (
    <p>
      整体 {overview.overall}% · 理论 {overview.expected}% · 落后 {overview.behind}% · 遗留 {overview.deferred} 项
    </p>
  );
}

function MyTasks({ org, item }: { org: string; item: Item }) {
  if (item.myTaskCount === 0) return <p className="text-muted-foreground">本迭代没有你的未完成任务。</p>;
  return (
    <div>
      <p className="text-muted-foreground">本迭代未完成 {item.myTaskCount}</p>
      <ul>
        {item.myTasks.map((task) => (
          <li key={task.id}>
            <Link href={nowIterationTaskHref(org, item.id, task)} className="flex h-8 min-w-0 items-center gap-2 hover:underline">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.displayKey}</span>
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              {task.requirement ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.requirement.displayKey}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
      {item.myTaskCount > item.myTasks.length ? (
        <Link href={iterationGanttHref(org, item.id)} className="text-xs text-primary hover:underline">
          还有 {item.myTaskCount - item.myTasks.length} 条，在甘特里看
        </Link>
      ) : null}
    </div>
  );
}
