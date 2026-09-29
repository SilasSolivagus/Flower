import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDate } from '@/features/requirements/format';
import { RELATION_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import type { RequirementDetail } from '@/lib/types';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border bg-card p-4" aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">{children}</ul>
    </section>
  );
}

export function SideLists({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  return (
    <>
      {r.assignments.length > 0 && (
        <Block title="开发分配">
          {r.assignments.map((a, i) => (
            <li key={i}>
              {a.member.displayName}
              <span className="text-muted-foreground">{[a.functionTag?.name, a.platform?.label].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
            </li>
          ))}
        </Block>
      )}
      {r.blockers.length > 0 && (
        <Block title="阻塞项">
          {[...r.blockers]
            .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1))
            .map((b) => (
              <li key={b.id} className={b.status === 'resolved' ? 'text-muted-foreground line-through' : ''}>
                {b.description}
              </li>
            ))}
        </Block>
      )}
      {r.tasks.length > 0 && (
        <Block title="任务">
          {r.tasks.map((t) => (
            <li key={t.id} className="flex flex-col">
              <span>{t.title}</span>
              <span className="text-[12px] text-muted-foreground">
                {[t.assignee?.displayName, TASK_STATUS_LABEL[t.status], t.planStart && `${t.planStart} 起`, t.planDays && `${t.planDays} 天`].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </Block>
      )}
      {r.releases.length > 0 && (
        <Block title="发布版本">
          {r.releases.map((x) => (
            <li key={x.id}>
              {x.platform?.label} <span className="font-mono">{x.versionName}</span>
              <span className="text-muted-foreground"> · {x.status === 'released' ? `已发布 ${x.releasedAt ? formatDate(x.releasedAt) : ''}` : '计划中'}</span>
            </li>
          ))}
        </Block>
      )}
      {r.relations.length > 0 && (
        <Block title="关联需求">
          {r.relations.map((x) => (
            <li key={`${x.type}-${x.other.id}`}>
              <span className="text-muted-foreground">{RELATION_LABEL[x.type] ?? x.type} </span>
              <Link className="font-mono hover:underline" href={`/${org}/requirements/${x.other.displayKey}`}>
                {x.other.displayKey}
              </Link>{' '}
              {x.other.title}
            </li>
          ))}
        </Block>
      )}
    </>
  );
}
