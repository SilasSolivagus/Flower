import { NoAccess } from '@/components/no-access';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isAccessDenied } from '@/lib/api';

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <p className="text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/** 查询失败时的统一显示：403 / 404 显示「无权访问」，其他错误（5xx、网络失败）显示「重试」。 */
export function QueryError({
  error,
  noAccessMessage,
  retryMessage,
  onRetry,
}: {
  error: unknown;
  noAccessMessage: string;
  retryMessage: string;
  onRetry: () => void;
}) {
  if (isAccessDenied(error)) return <NoAccess message={noAccessMessage} />;
  return <LoadError message={retryMessage} onRetry={onRetry} />;
}

/** 列表或关键区域还在取数：骨架加上「加载中」，避免慢网时只剩一块空白。 */
export function LoadingBlock({ className = 'h-40' }: { className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-2">
      <Skeleton className={className} />
      <p className="text-sm text-muted-foreground">加载中</p>
    </div>
  );
}
