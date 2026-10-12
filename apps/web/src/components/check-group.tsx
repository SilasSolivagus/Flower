'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { toggle } from '@/features/notifications/model';

/** 一组复选框；每个选项的无障碍名称为「{legend}：{label}」。indent 为缩进层级（结构树节点）。 */
export function CheckGroup({
  legend,
  hint,
  options,
  value,
  onChange,
}: {
  legend: string;
  hint?: string;
  options: Array<{ value: string; label: string; indent?: number }>;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-[13px]" style={o.indent ? { paddingLeft: o.indent * 12 } : undefined}>
            <Checkbox aria-label={`${legend}：${o.label}`} checked={value.includes(o.value)} onCheckedChange={() => onChange(toggle(value, o.value))} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
