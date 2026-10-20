'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { qk, useSubscription } from '@/lib/queries';
import type { Subscription } from '@/lib/types';

/** 需求、PRD、工作项详情的关注按钮：点下去立刻换成已关注或关注，失败再改回来。 */
export function FollowButton({ org, type, id }: { org: string; type: 'requirement' | 'document' | 'work_item'; id: string }) {
  const qc = useQueryClient();
  const q = useSubscription(org, type, id);
  const key = qk.subscription(org, type, id);
  const toggle = useMutation({
    mutationFn: (following: boolean) => api<{ subscription: Subscription }>(`/orgs/${org}/subscriptions/${type}/${id}`, { method: 'PUT', body: { following } }),
    onMutate: async (following) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ subscription: Subscription }>(key);
      qc.setQueryData(key, {
        subscription: {
          following,
          source: following ? 'manual' : null,
          reason: following ? '你手动关注了' : null,
        },
      });
      return { prev };
    },
    onError: (e, _following, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(e instanceof ApiError ? e.message : '操作失败，请稍后重试');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
  if (!q.data) return null;
  const s = q.data;
  return (
    <Button
      variant={s.following ? 'secondary' : 'outline'}
      size="sm"
      aria-pressed={s.following}
      aria-busy={toggle.isPending}
      title={s.following ? (s.reason ?? '已关注') : type === 'work_item' ? '关注后，新的进展记录会通知你' : '关注后，状态、优先级、迭代变化与新评论会通知你'}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!s.following)}
    >
      {s.following ? <BellOff className="size-4" aria-hidden="true" /> : <BellPlus className="size-4" aria-hidden="true" />}
      {s.following ? '已关注' : '关注'}
    </Button>
  );
}
