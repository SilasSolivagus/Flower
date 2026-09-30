'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { LoadError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { useMe, useSetupStatus } from '@/lib/queries';

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const setup = useSetupStatus();
  const me = useMe();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (setup.data && !setup.data.initialized) router.replace('/setup');
    else if (unauthenticated) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [setup.data, unauthenticated, pathname, router]);

  if (!me.data) {
    if (me.isError && !unauthenticated) return <LoadError message="加载账号信息失败，请重试。" onRetry={() => me.refetch()} />;
    return (
      <div className="flex h-screen items-center justify-center" aria-busy="true">
        <Skeleton className="h-6 w-40" />
      </div>
    );
  }
  return <>{children}</>;
}
