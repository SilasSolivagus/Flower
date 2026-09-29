'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Field, WorkflowBody } from '@/lib/types';
import { ANY, getConditions, setConditions, toggleTransition } from '../model';
import { ConditionEditor } from './condition-editor';

export function ConditionSheet({
  body,
  fields,
  selected,
  onChange,
  onClose,
}: {
  body: WorkflowBody;
  fields: Field[];
  selected: { from: string; to: string } | null;
  onChange: (b: WorkflowBody) => void;
  onClose: () => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  if (!selected) return null;
  const label = (k: string) => (k === ANY ? '任意状态' : (body.states.find((s) => s.key === k)?.label ?? k));
  const title = `${label(selected.from)} → ${label(selected.to)}`;
  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="flex w-[420px] flex-col gap-4 sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>满足全部条件才能流转。</SheetDescription>
        </SheetHeader>
        <div className="px-4" ref={setContainer}>
          <ConditionEditor
            body={body}
            fields={fields}
            value={getConditions(body, selected.from, selected.to)}
            onChange={(c) => onChange(setConditions(body, selected.from, selected.to, c))}
            portalContainer={container}
          />
        </div>
        <SheetFooter className="mt-auto flex-row justify-between">
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => {
              onChange(toggleTransition(body, selected.from, selected.to));
              onClose();
            }}
          >
            删除这条流转
          </Button>
          <Button onClick={onClose}>完成</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
