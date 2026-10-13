import { Button } from '@/components/ui/button';

/** 地址栏里的时间段参数不合法（接口返回 400）：显示原因，一键恢复默认时间段，而不是反复重试。 */
export function InvalidFilter({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onReset}>
        恢复默认时间段
      </Button>
    </div>
  );
}
