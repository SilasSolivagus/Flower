import type { ReactNode } from 'react';

/**
 * 禁用按钮不接收指针，原生 title 经常出不来。
 * 理由放在外层 title，并在按钮旁写一句，悬停和扫视都能看到。
 */
export function DisabledReason({ disabled, reason, children }: { disabled: boolean; reason?: string; children: ReactNode }) {
  if (!disabled || !reason) return children;
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <span title={reason} className="inline-flex">
        {children}
      </span>
      <span className="text-[12px] leading-4 text-muted-foreground">{reason}</span>
    </span>
  );
}
