import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './logo';
import { UserMenu } from './user-menu';

export function PlainShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="flex h-12 items-center justify-between border-b bg-card px-6">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <Logo />
          Flower
        </Link>
        <UserMenu />
      </div>
      <main className="mx-auto flex max-w-[960px] flex-col gap-5 px-8 py-8">{children}</main>
    </div>
  );
}
