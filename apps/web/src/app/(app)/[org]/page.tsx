'use client';

import Link from 'next/link';
import { type ReactNode, useId } from 'react';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { requirementHref, showOrgBadge, taskHref } from '@/features/workbench/model';
import { useWorkbench } from '@/lib/queries';
import type { Workbench } from '@/lib/types';

const ROW = 'flex h-10 items-center gap-3 px-4 text-[13px] hover:bg-muted';

function Section({ title, total, shown, empty, children }: { title: string; total: number; shown: number; empty: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-lg border bg-card">
      <h2 id={id} className="flex items-center justify-between border-b px-4 py-2.5 font-semibold">
        {title}
        <span className="font-mono text-xs font-normal text-muted-foreground">{total}</span>
      </h2>
      {total === 0 ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{empty}</p> : <ul className="divide-y">{children}</ul>}
      {total > shown && <p className="border-t px-4 py-2 text-xs text-muted-foreground">只显示前 {shown} 条</p>}
    </section>
  );
}

function OrgBadge({ show, name }: { show: boolean; name: string }) {
  return show ? <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{name}</span> : null;
}

function Sections({ data }: { data: Workbench }) {
  const badge = showOrgBadge(data.orgs);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Section title="我负责的需求" total={data.owned.total} shown={data.owned.items.length} empty="没有进行中的需求">
        {data.owned.items.map((r) => (
          <li key={r.id}>
            <Link href={requirementHref(r.org, r.displayKey)} className={ROW}>
              <OrgBadge show={badge} name={r.org.name} />
              <span className="font-mono text-muted-foreground">{r.displayKey}</span>
              <span className="flex-1 truncate">{r.title}</span>
              <span className="text-xs" style={{ color: r.state.color }}>
                {r.state.label}
              </span>
            </Link>
          </li>
        ))}
      </Section>
      <Section title="我的任务" total={data.tasks.total} shown={data.tasks.items.length} empty="没有未完成的任务">
        {data.tasks.items.map((t) => (
          <li key={t.id}>
            <Link href={taskHref(t)} className={ROW}>
              <OrgBadge show={badge} name={t.org.name} />
              <span className="flex-1 truncate">{t.title}</span>
              {t.requirement && <span className="font-mono text-xs text-muted-foreground">{t.requirement.displayKey}</span>}
              {t.iteration && <span className="text-xs text-muted-foreground">{t.iteration.name}</span>}
              <span className="font-mono text-xs text-muted-foreground">{t.planStart ?? '未排期'}</span>
              <span className="w-10 text-right font-mono text-xs">{t.progress}%</span>
            </Link>
          </li>
        ))}
      </Section>
      <Section title="等我签字" total={data.signatures.total} shown={data.signatures.items.length} empty="没有等你签字的检查项">
        {data.signatures.items.map((s) => (
          <li key={`${s.requirementId}-${s.itemKey}-${s.ruleIndex}`}>
            <Link href={requirementHref(s.org, s.displayKey)} className={ROW}>
              <OrgBadge show={badge} name={s.org.name} />
              <span className="font-mono text-muted-foreground">{s.displayKey}</span>
              <span className="flex-1 truncate">{s.title}</span>
              <span className="text-xs">{s.itemLabel}</span>
              {s.onBehalfOf && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">代 {s.onBehalfOf}</span>}
            </Link>
          </li>
        ))}
      </Section>
      <Section title="未读评论" total={data.unread.total} shown={data.unread.items.length} empty="你负责的需求上没有未读评论">
        {data.unread.items.map((u) => (
          <li key={u.requirementId}>
            <Link href={requirementHref(u.org, u.displayKey)} className={ROW}>
              <OrgBadge show={badge} name={u.org.name} />
              <span className="font-mono text-muted-foreground">{u.displayKey}</span>
              <span className="flex-1 truncate">{u.title}</span>
              <span className="text-xs text-primary">{u.unread} 条未读</span>
            </Link>
          </li>
        ))}
      </Section>
    </div>
  );
}

export default function WorkbenchPage() {
  const q = useWorkbench();
  let body: ReactNode;
  if (q.data) body = <Sections data={q.data} />;
  else if (q.isError) body = <QueryError error={q.error} noAccessMessage="无法读取工作台。" retryMessage="加载工作台失败，请重试。" onRetry={() => q.refetch()} />;
  else body = <Skeleton className="h-64" />;
  return (
    <>
      <PageHeader title="工作台" description="汇总你在所有组织里负责的需求、指派给你的任务、等你签字的检查项和未读评论。" />
      {body}
    </>
  );
}
