import type { LegacyData } from './legacy-types';
import type { Mapping } from './mapping';
import { buildBase } from './plan-base';
import { type ImportOptions, type ImportPlan, PlanContext } from './plan-types';

export function buildImportPlan(data: LegacyData, mapping: Mapping, opts: ImportOptions): ImportPlan {
  const ctx = new PlanContext(data, mapping, opts);
  buildBase(ctx);
  return { rows: ctx.rows, report: ctx.report };
}
