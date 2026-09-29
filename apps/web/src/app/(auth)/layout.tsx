import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <div className="flex items-center gap-2 text-lg font-bold">
        <Logo size={26} />
        Flower
      </div>
      <div className="w-full max-w-[420px] rounded-lg border bg-card p-6 shadow-sm">{children}</div>
    </div>
  );
}
