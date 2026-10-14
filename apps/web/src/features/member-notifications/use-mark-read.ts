'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';
import { inboxKeys, useApiMutation } from '@/lib/queries';

/** 打开需求、PRD、任务或工作项详情时，把本人与它相关的未读通知标为已读（失败不提示）。subjectId 为空（还在加载）时不调用。 */
export function useMarkNotificationsRead(org: string, subjectType: 'requirement' | 'document' | 'task' | 'work_item', subjectId: string | undefined): void {
  const read = useApiMutation((id: string) => api(`/orgs/${org}/notifications/read-subject`, { method: 'POST', body: { subjectType, subjectId: id } }), {
    invalidate: [inboxKeys(org)],
    silentError: true,
  });
  const mutate = read.mutate;
  useEffect(() => {
    if (subjectId) mutate(subjectId);
  }, [subjectId, mutate]);
}
