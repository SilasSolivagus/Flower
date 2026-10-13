'use client';

import { CircleHelp } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** 指标旁的「?」：悬停或键盘聚焦时显示口径。 */
export function MetricHelp({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`${label}的口径`} className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground">
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{text}</TooltipContent>
    </Tooltip>
  );
}
