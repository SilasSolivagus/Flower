'use client';

import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useId } from 'react';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { confirmationHref, emptySectionHref, showOrgBadge, signatureHref, subjectHref, taskHref, unreadHref } from '@/features/workbench/model';
import { useWorkbench } from '@/lib/queries';
import type { Workbench } from '@/lib/types';

const ROW = 'flex h-10 items-center gap-3 px-4 text-[13px] hover:bg-muted';

function Section({
  title,
  hint,
  total,
  shown,
  empty,
  emptyHref,
  moreHref,
  moreLabel,
  children,
}: {
  title: string;
  hint?: string;
  total: number;
  shown: number;
  empty: string;
  emptyHref?: string;
  moreHref?: string;
  moreLabel?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-lg border bg-card">
      <h2 id={id} className="flex items-center justify-between border-b px-4 py-2.5 font-semibold">
        <span className="flex min-w-0 items-baseline gap-2">
          {title}
          {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
        </span>
        <span className="flex items-center gap-3">
          {moreHref && moreLabel ? (
            <Link href={moreHref} className="text-xs font-normal text-primary hover:underline">
              {moreLabel}
            </Link>
          ) : null}
          <span className="font-mono text-xs font-normal text-muted-foreground">{total}</span>
        </span>
      </h2>
      {total === 0 ? (
        emptyHref ? (
          <Link href={emptyHref} className="px-4 py-6 text-center text-[13px] text-primary hover:underline">
            {empty}
          </Link>
        ) : (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{empty}</p>
        )
      ) : (
        <ul className="divide-y">{children}</ul>
      )}
      {total > shown && <p className="border-t px-4 py-2 text-xs text-muted-foreground">只显示前 {shown} 条</p>}
    </section>
  );
}

function OrgBadge({ show, name }: { show: boolean; name: string }) {
  return show ? <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{name}</span> : null;
}

function Sections({ org, data }: { org: string; data: Workbench }) {
  const badge = showOrgBadge(data.orgs);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Section title="我负责的需求与工作项" total={data.owned.total} shown={data.owned.items.length} empty="没有进行中的需求与工作项" emptyHref={emptySectionHref(org, 'owned')}>
        {data.owned.items.map((r) => (
          <li key={r.id}>
            <Link href={subjectHref(r)} className={ROW}>
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
      <Section title="等我跟进" total={data.following.total} shown={data.following.items.length} empty="没有等你跟进的条目" emptyHref={emptySectionHref(org, 'following')}>
        {data.following.items.map((f) => (
          <li key={f.id}>
            <Link href={subjectHref(f)} className={ROW}>
              <OrgBadge show={badge} name={f.org.name} />
              <span className="font-mono text-muted-foreground">{f.displayKey}</span>
              <span className="flex-1 truncate">{f.title}</span>
              {f.nextStep && <span className="max-w-48 truncate text-xs text-muted-foreground">{f.nextStep}</span>}
            </Link>
          </li>
        ))}
      </Section>
      <Section
        title="我的任务"
        total={data.tasks.total}
        shown={data.tasks.items.length}
        empty="没有未完成的任务"
        emptyHref={emptySectionHref(org, 'tasks')}
        moreHref={`/${org}/tasks`}
        moreLabel="查看全部"
      >
        {data.tasks.items.map((t) => (
          <li key={t.id}>
            <Link href={taskHref(t)} className={ROW}>
              <OrgBadge show={badge} name={t.org.name} />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.displayKey}</span>
              <span className="flex-1 truncate">{t.title}</span>
              {t.requirement && <span className="font-mono text-xs text-muted-foreground">{t.requirement.displayKey}</span>}
              {t.iteration && <span className="text-xs text-muted-foreground">{t.iteration.name}</span>}
              <span className="font-mono text-xs text-muted-foreground">{t.planStart ?? '未排期'}</span>
              <span className="w-10 text-right font-mono text-xs">{t.progress}%</span>
            </Link>
          </li>
        ))}
      </Section>
      <Section title="等我确认" hint="检查项" total={data.signatures.total} shown={data.signatures.items.length} empty="没有等你确认的检查项" emptyHref={emptySectionHref(org, 'signatures')}>
        {data.signatures.items.map((s) => (
          <li key={`${s.requirementId ?? s.documentId}-${s.itemKey}-${s.ruleIndex}`}>
            <Link href={signatureHref(s)} className={ROW}>
              <OrgBadge show={badge} name={s.org.name} />
              <span className="font-mono text-muted-foreground">{s.displayKey}</span>
              <span className="flex-1 truncate">{s.title}</span>
              <span className="text-xs">{s.itemLabel}</span>
              {s.onBehalfOf && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">代 {s.onBehalfOf}</span>}
            </Link>
          </li>
        ))}
      </Section>
      <Section title="等我确认" hint="简报" total={data.confirmations.total} shown={data.confirmations.items.length} empty="暂无需要你确认的简报" emptyHref={emptySectionHref(org, 'confirmations')}>
        {data.confirmations.items.map((c) => (
          <li key={c.documentId}>
            <Link href={confirmationHref(c)} className={ROW}>
              <OrgBadge show={badge} name={c.org.name} />
              <span className="font-mono text-muted-foreground">{c.displayKey}</span>
              <span className="flex-1 truncate">{c.title}</span>
              <span className="text-xs text-muted-foreground">{DOCUMENT_STATUS_LABELS[c.status]}</span>
            </Link>
          </li>
        ))}
      </Section>
      <Section title="未读评论" total={data.unread.total} shown={data.unread.items.length} empty="没有未读评论" emptyHref={emptySectionHref(org, 'unread')}>
        {data.unread.items.map((u) => (
          <li key={u.requirementId ?? u.documentId}>
            <Link href={unreadHref(u)} className={ROW}>
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
  const { org } = useParams<{ org: string }>();
  const q = useWorkbench();
  let body: ReactNode;
  if (q.data) body = <Sections org={org} data={q.data} />;
  else if (q.isError) body = <QueryError error={q.error} noAccessMessage="无法读取工作台。" retryMessage="加载工作台失败，请重试。" onRetry={() => q.refetch()} />;
  else body = <Skeleton className="h-64" />;
  return (
    <>
      <PageHeader title="工作台" description="汇总你在所有组织里负责的需求与工作项、等你跟进的条目、指派给你的任务、等你确认的简报、等你确认的检查项和未读评论。" />
      {body}
    </>
  );
}
