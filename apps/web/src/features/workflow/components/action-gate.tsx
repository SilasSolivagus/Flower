'use client';

import type { Field, WorkflowBody } from '@/lib/types';
import { getGateConditions, setGateConditions } from '../model';
import { ConditionEditor } from './condition-editor';

export function ActionGate({ body, fields, onChange }: { body: WorkflowBody; fields: Field[]; onChange: (b: WorkflowBody) => void }) {
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <div>
        <h3 className="font-medium">加入迭代</h3>
        <p className="text-[13px] text-muted-foreground">需求加入迭代前必须满足以下全部条件，例如“PRD 评审通过”。</p>
      </div>
      <ConditionEditor body={body} fields={fields} value={getGateConditions(body)} onChange={(c) => onChange(setGateConditions(body, c))} />
    </div>
  );
}
