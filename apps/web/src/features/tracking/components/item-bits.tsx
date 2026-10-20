import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AGING_CLASS, AGING_LABEL } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 本阶段停留天数：超过阈值时标黄或标红（暂停中不标色）。 */
export function AgingDays({ item }: { item: TrackingItem }) {
  return (
    <span className={cn('inline-block whitespace-nowrap rounded-sm px-1.5 font-mono', AGING_CLASS[item.aging])} title={AGING_LABEL[item.aging] || undefined}>
      {item.stageDays} 天
    </span>
  );
}

/** 当前阶段：颜色点与名称；暂停时加「已暂停」标签，悬停显示原因。 */
export function StageLabel({ item }: { item: TrackingItem }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      <span className="size-2 shrink-0 rounded-full" style={{ background: item.stage.color }} aria-hidden="true" />
      {item.stage.label}
      {item.paused && (
        <Badge variant="outline" title={item.paused.reason}>
          已暂停
        </Badge>
      )}
    </span>
  );
}

/** 最新进展 · 下一步 · 跟进人：一行，超出截断，悬停看全文。 */
export function LatestProgress({ item }: { item: TrackingItem }) {
  const l = item.latest;
  if (!l) return <span className="text-muted-foreground">没有进展记录</span>;
  const full = [l.body, l.nextStep && `下一步：${l.nextStep}`, l.follower && `跟进人：${l.follower.displayName}`].filter(Boolean).join(' · ');
  return (
    <span className="block max-w-80 truncate" title={full}>
      {l.body}
      {l.nextStep && <span className="text-muted-foreground"> · 下一步：{l.nextStep}</span>}
      {l.follower && <span className="text-muted-foreground"> · {l.follower.displayName}</span>}
    </span>
  );
}

/** 「写进展」：只对能写的条目显示。 */
export function WriteButton({ item, onWrite }: { item: TrackingItem; onWrite: (item: TrackingItem) => void }) {
  if (!item.canWrite) return null;
  return (
    <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" aria-label={`写进展：${item.displayKey}`} onClick={() => onWrite(item)}>
      写进展
    </Button>
  );
}
