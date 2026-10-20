'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * 详情页标题：编号加标题，有编辑权限时点击变为输入框，回车提交、失焦取消。
 * onSubmit 收到新标题和关闭输入框的回调，由页面在保存成功后调用。
 */
export function EditableTitle({
  displayKey,
  title,
  canEdit,
  onSubmit,
}: {
  displayKey: string;
  title: string;
  canEdit: boolean;
  onSubmit: (title: string, close: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const close = () => setEditing(false);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(draft, close);
        }}
      >
        <Input aria-label="标题" className="h-9 text-xl font-semibold" value={draft} autoFocus maxLength={200} onChange={(e) => setDraft(e.target.value)} onBlur={close} />
      </form>
    );
  }
  return (
    <button
      type="button"
      disabled={!canEdit}
      className="block w-full min-w-0 whitespace-normal break-words text-left disabled:cursor-default"
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
    >
      <span className="mr-2 font-mono text-base text-muted-foreground">{displayKey}</span>
      {title}
    </button>
  );
}
