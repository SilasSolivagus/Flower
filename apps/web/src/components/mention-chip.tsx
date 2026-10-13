import type { Mention } from '@flower/core/links';
import { mentionTitle } from '@/features/mentions/model';
import type { MentionMember } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * 正文里的 @：在职成员按成员 ID 显示当前姓名；成员已离开或查不到（member 为 null）时显示为灰色，用写入时的姓名。
 * member 为 undefined 表示成员列表还在加载，先按写入时的姓名正常显示。
 */
export function MentionChip({ mention, member }: { mention: Mention; member: MentionMember | null | undefined }) {
  const grey = member === null || member?.status === 'left';
  const name = grey ? mention.name : (member?.displayName ?? mention.name);
  return (
    <span
      title={mentionTitle(member)}
      data-member-id={mention.memberId}
      className={cn('mx-0.5 rounded-sm px-1 text-[13px]', grey ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')}
    >
      @{name}
    </span>
  );
}
