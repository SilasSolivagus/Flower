import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ValidationIssue } from '@flower/core/workflow-schema';

export function ValidationPanel({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) {
    return (
      <span className="flex items-center gap-1.5 text-[13px] text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="size-4" aria-hidden="true" />
        校验通过
      </span>
    );
  }
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-4" aria-hidden="true" />有 {issues.length} 个问题需要修正后才能发布
      </p>
      <ul className="mt-1 list-disc pl-6">
        {issues.slice(0, 6).map((i, n) => (
          <li key={n}>{i.message}</li>
        ))}
      </ul>
    </div>
  );
}
