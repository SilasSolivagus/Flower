'use client';

import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useId, useState } from 'react';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { confirmationHref, emptySectionHref, showOrgBadge, signatureHref, subjectHref, taskHref, unreadHref, workbenchIsEmpty } from '@/features/workbench/model';
import { useWorkbench } from '@/lib/queries';
import type { Workbench } from '@/lib/types';

const ROW = 'flex h-10 min-w-0 items-center gap-3 overflow-hidden px-4 text-[13px] hover:bg-muted';
/** 任务行字段比别的区块多。间距收一档，避免 1280 两列和 1920 三列把长标题挤到 8 字以下。 */
const TASK_ROW = 'flex h-10 min-w-0 items-center gap-2 overflow-hidden px-4 text-[13px] hover:bg-muted';
const WORKBENCH_ABOUT = '汇总你在所有组织里负责的需求与工作项、等你跟进的条目、指派给你的任务、等你确认的简报、等你确认的检查项和未读评论。';

const EMPTY_LINKS: Array<{ label: string; section: Parameters<typeof emptySectionHref>[1] }> = [
  { label: '需求', section: 'owned' },
  { label: '跟进', section: 'following' },
  { label: '任务', section: 'tasks' },
  { label: '检查项', section: 'signatures' },
  { label: '简报', section: 'confirmations' },
  { label: '未读评论', section: 'unread' },
];

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
    <section aria-labelledby={id} className="flex min-w-0 flex-col justify-start overflow-hidden rounded-lg border bg-card">
      <h2 id={id} className="flex items-center justify-between border-b px-4 py-2.5 font-semibold">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{title}</span>
          {hint ? <span className="shrink-0 text-xs font-normal text-muted-foreground">{hint}</span> : null}
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
          <Link href={emptyHref} className="shrink-0 px-4 py-2 text-left text-[13px] text-primary hover:underline">
            {empty}
          </Link>
        ) : (
          <p className="shrink-0 px-4 py-2 text-left text-[13px] text-muted-foreground">{empty}</p>
        )
      ) : (
        <ul className="divide-y">{children}</ul>
      )}
      {total > shown && <p className="border-t px-4 py-2 text-xs text-muted-foreground">只显示前 {shown} 条</p>}
    </section>
  );
}

/** 三列时徽标收到 3.5em。4em 时标题只剩 108px，第 8 个字的中线还差约 0.5px，被省略号挡住。 */
function OrgBadge({ show, name, compactAt3xl = false }: { show: boolean; name: string; compactAt3xl?: boolean }) {
  if (!show) return null;
  return (
    <span
      title={compactAt3xl ? name : undefined}
      className={
        compactAt3xl
          ? 'shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground 3xl:min-w-0 3xl:max-w-[3.5em] 3xl:shrink 3xl:truncate'
          : 'shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground'
      }
    >
      {name}
    </span>
  );
}

function WorkbenchDescription() {
  const [open, setOpen] = useState(false);
  const aboutId = useId();
  return (
    <>
      你负责、跟进、任务和待确认的条目。
      <button type="button" className="ml-1.5 text-primary hover:underline" aria-expanded={open} aria-controls={aboutId} onClick={() => setOpen((v) => !v)}>
        {open ? '收起' : '了解更多'}
      </button>
      <span id={aboutId} className={open ? 'mt-1 block' : 'hidden'}>
        {WORKBENCH_ABOUT}
      </span>
    </>
  );
}

function EmptyWorkbench({ org }: { org: string }) {
  return (
    <div role="group" aria-label="工作台空态" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed bg-muted/60 px-4 py-2 text-[13px]">
      <p role="status">没有需要你处理的条目。</p>
      <nav aria-label="去列表" className="flex flex-wrap items-center">
        {EMPTY_LINKS.map((l, i) => (
          <span key={l.section} className="inline-flex items-center">
            {i > 0 ? (
              <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
                ·
              </span>
            ) : null}
            <Link href={emptySectionHref(org, l.section)} className="text-primary hover:underline">
              {l.label}
            </Link>
          </span>
        ))}
      </nav>
    </div>
  );
}

function Sections({ org, data }: { org: string; data: Workbench }) {
  const badge = showOrgBadge(data.orgs);
  if (workbenchIsEmpty(data)) return <EmptyWorkbench org={org} />;
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2 3xl:grid-cols-3">
      <Section title="我负责的需求与工作项" total={data.owned.total} shown={data.owned.items.length} empty="没有进行中的需求与工作项" emptyHref={emptySectionHref(org, 'owned')}>
        {data.owned.items.map((r) => (
          <li key={r.id}>
            <Link href={subjectHref(r)} className={ROW}>
              <OrgBadge show={badge} name={r.org.name} />
              <span className="font-mono text-muted-foreground">{r.displayKey}</span>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
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
              <span className="min-w-0 flex-1 truncate">{f.title}</span>
              {f.nextStep && <span className="min-w-0 max-w-48 shrink truncate text-xs text-muted-foreground">{f.nextStep}</span>}
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
            <Link href={taskHref(t)} className={TASK_ROW}>
              <OrgBadge show={badge} name={t.org.name} compactAt3xl />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.displayKey}</span>
              <span className="min-w-[64px] flex-1 truncate">{t.title}</span>
              {t.requirement && <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.requirement.displayKey}</span>}
              {t.iteration && (
                <span title={t.iteration.name} className="min-w-0 max-w-24 truncate text-xs text-muted-foreground">
                  {t.iteration.name}
                </span>
              )}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.planStart ?? '未排期'}</span>
              <span className="w-10 shrink-0 text-right font-mono text-xs">{t.progress}%</span>
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
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="max-w-24 shrink-0 truncate text-xs">{s.itemLabel}</span>
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
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
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
              <span className="min-w-0 flex-1 truncate">{u.title}</span>
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
      <PageHeader title="工作台" description={<WorkbenchDescription />} />
      {body}
    </>
  );
}
