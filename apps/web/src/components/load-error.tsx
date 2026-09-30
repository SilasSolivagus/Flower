import { NoAccess } from '@/components/no-access';
import { Button } from '@/components/ui/button';
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
