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
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="mx-1.5">/</span>}
              {c.href ? (
                <Link href={c.href} className="hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                c.label
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-xl font-semibold">{title}</h1>
          {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
