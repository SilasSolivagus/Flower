'use client';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { WorkflowVersion } from '@/lib/types';

export function VersionHistory({ versions }: { versions: WorkflowVersion[] }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">版本历史</Button>
      </SheetTrigger>
      <SheetContent className="w-[380px] sm:max-w-[380px]">
        <SheetHeader>
          <SheetTitle>版本历史</SheetTitle>
          <SheetDescription>每个版本发布后不可修改。</SheetDescription>
        </SheetHeader>
        <ol className="flex flex-col divide-y px-4">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-col gap-1 py-3">
              <span className="flex items-center gap-2">
                <span className="rounded-sm bg-muted px-1.5 font-mono text-xs">v{v.version}</span>
                <span className="font-mono text-xs text-muted-foreground">{v.createdAt.slice(0, 16).replace('T', ' ')}</span>
              </span>
              <span className="text-[13px]">{v.note || '—'}</span>
            </li>
          ))}
        </ol>
      </SheetContent>
    </Sheet>
  );
}
