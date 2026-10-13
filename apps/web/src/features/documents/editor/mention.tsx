'use client';

import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactInlineContentSpec } from '@blocknote/react';
import { createContext, useContext } from 'react';
import { mentionEditorHref, mentionTitle } from '@/features/mentions/model';
import type { MentionMember } from '@/lib/types';
import { cn } from '@/lib/utils';

const MEMBER_HREF = /^member:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?n=([0-9a-z%._~-]*))?$/i;

function decodeName(encoded: string | undefined): string | undefined {
  try {
    return encoded === undefined ? undefined : decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** 编辑器里 @ 显示当前姓名用的成员列表；没有提供时（undefined）按写入时的姓名显示。 */
export const MentionMembersContext = createContext<MentionMember[] | undefined>(undefined);

/** 与评论里的成员标签（components/mention-chip.tsx）规则相同：在职成员显示当前姓名，已离开或查不到时灰色显示写入时的姓名。 */
function MentionView({ memberId, name }: { memberId: string; name: string }) {
  const members = useContext(MentionMembersContext);
  const member = members ? (members.find((m) => m.id === memberId.toLowerCase()) ?? null) : undefined;
  const grey = member === null || member?.status === 'left';
  return (
    <span className={cn('mention-chip', grey && 'mention-chip-grey')} title={mentionTitle(member)} data-member-id={memberId}>
      @{grey ? name : (member?.displayName ?? name)}
    </span>
  );
}

/**
 * PRD 正文里的 @ 成员。Markdown 写法为 `[@姓名](member:成员ID)`。读入前由 encodeMentionsForEditor、导出后由
 * restoreMentionMarkup 在它与带姓名编码的 member: 链接之间转换；导入时按 member: 链接识别
 * （BlockNote 的链接只接受 http 等协议，不会抢先解析），姓名取链接里的编码，没有时取链接文字。
 */
export const Mention = createReactInlineContentSpec(
  { type: 'mention', propSchema: { memberId: { default: '' }, name: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent }) => <MentionView memberId={inlineContent.props.memberId} name={inlineContent.props.name} />,
    toExternalHTML: ({ inlineContent }) => <a href={mentionEditorHref(inlineContent.props.memberId, inlineContent.props.name)}>@{inlineContent.props.name}</a>,
    parse: (el) => {
      if (el.tagName !== 'A') return undefined;
      const m = MEMBER_HREF.exec(el.getAttribute('href') ?? '');
      if (!m) return undefined;
      // ID 保持原样，保存时写法不变；显示时按小写匹配成员
      return { memberId: m[1]!, name: decodeName(m[2]) ?? (el.textContent ?? '').replace(/^@/, '').trim() };
    },
  },
);

/** PRD 编辑器与 Markdown 解析共用的 schema：默认内联元素加上 mention。 */
export const prdSchema = BlockNoteSchema.create({ inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention } });
