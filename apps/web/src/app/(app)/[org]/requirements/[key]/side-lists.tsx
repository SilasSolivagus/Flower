import type { ReactNode } from 'react';
import { TASK_STATUS_LABEL } from '@/lib/labels';
import type { RequirementDetail } from '@/lib/types';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border bg-card p-4" aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">{children}</ul>
    </section>
  );
}

export function SideLists({ requirement: r }: { requirement: RequirementDetail }) {
  return (
    <>
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
    </>
  );
}
