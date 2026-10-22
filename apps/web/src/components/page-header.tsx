import Link from 'next/link';
import type { ReactNode } from 'react';

export type Crumb = { label: string; href?: string };

export function PageHeader({
  crumbs = [],
  title,
  description,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      {crumbs.length > 0 && (
        <nav aria-label="面包屑" className="text-[13px] text-muted-foreground">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={i}>
                {i > 0 && <span className="mx-1.5">/</span>}
                {last || !c.href ? (
                  <span aria-current={last ? 'page' : undefined}>{c.label}</span>
                ) : (
                  <Link href={c.href} className="hover:text-foreground">
                    {c.label}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      )}
      <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-end md:gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="min-w-0 text-xl font-semibold break-words">{title}</h1>
          {description && <p className="max-w-prose text-[13px] leading-6 break-words text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
