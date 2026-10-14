'use client';

import { BellOff, BellPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { qk, useApiMutation, useSubscription } from '@/lib/queries';
import type { Subscription } from '@/lib/types';

/** 需求、PRD、工作项详情的关注按钮：已关注时悬停说明原因，再点取消关注。 */
export function FollowButton({ org, type, id }: { org: string; type: 'requirement' | 'document' | 'work_item'; id: string }) {
  const q = useSubscription(org, type, id);
  const toggle = useApiMutation((following: boolean) => api<{ subscription: Subscription }>(`/orgs/${org}/subscriptions/${type}/${id}`, { method: 'PUT', body: { following } }), {
    invalidate: [qk.subscription(org, type, id)],
  });
  if (!q.data) return null;
  const s = q.data;
  return (
    <Button
      variant={s.following ? 'secondary' : 'outline'}
      size="sm"
      aria-pressed={s.following}
      title={s.following ? (s.reason ?? '已关注') : type === 'work_item' ? '关注后，新的进展记录会通知你' : '关注后，状态、优先级、迭代变化与新评论会通知你'}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!s.following)}
    >
      {s.following ? <BellOff className="size-4" aria-hidden="true" /> : <BellPlus className="size-4" aria-hidden="true" />}
      {s.following ? '已关注' : '关注'}
    </Button>
  );
}
