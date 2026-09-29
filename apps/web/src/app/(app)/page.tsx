'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useMe } from '@/lib/queries';

// AuthGate（(app)/layout.tsx）已经处理了未初始化 / 未登录时的跳转。
// 只有一个组织时直接进入；有多个组织时的选择页由 Task 7 实现。
export default function RootPage() {
  const router = useRouter();
  const me = useMe();
  const orgs = me.data?.orgs;

  useEffect(() => {
    if (orgs?.length === 1) router.replace(`/${orgs[0]!.slug}`);
  }, [orgs, router]);

  return null;
}
