'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeNavKey, buildNav } from '@/features/shell/nav';
import { cn } from '@/lib/utils';

/** 窄屏组织设置的顶栏：横向切换子页，标签保持横排，超出时在自己的容器里滚动。 */
export function SettingsSubnav({ org }: { org: string }) {
  const pathname = usePathname();
  const active = activeNavKey(pathname, org);
  const items = buildNav(org, 'admin').settings;
  return (
    <nav aria-label="组织设置" className="min-w-0 overflow-x-auto md:hidden">
      <div className="flex w-max gap-1">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href ?? '#'}
            aria-current={item.key === active ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap',
              item.key === active ? 'bg-accent font-semibold text-accent-foreground' : 'text-foreground hover:bg-muted',
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
