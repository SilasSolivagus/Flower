import type { ReactNode } from 'react';
import { OrgShell } from '@/components/org-shell';

export default function OrgLayout({ children }: { children: ReactNode }) {
  return <OrgShell>{children}</OrgShell>;
}
