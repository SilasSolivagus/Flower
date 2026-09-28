import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin, requireProductRole } from '../access/permissions';
import { randomToken } from '../crypto';
import type { Db } from '../db/client';
import { fieldDefinitions, fieldOptions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';

export type FieldOptionView = { id: string; key: string; label: string; color: string | null; sort: number; active: boolean };
export type FieldView = {
  id: string;
  key: string;
  label: string;
  cardinality: 'single' | 'multi';
  builtin: boolean;
  productId: string | null;
  options: FieldOptionView[];
};

type FieldRow = typeof fieldDefinitions.$inferSelect;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

const optionView = (o: typeof fieldOptions.$inferSelect): FieldOptionView => ({
  id: o.id, key: o.key, label: o.label, color: o.color, sort: o.sort, active: o.active,
});

async function withOptions(tx: Tx, rows: FieldRow[]): Promise<FieldView[]> {
  const result: FieldView[] = [];
  for (const f of rows) {
    const opts = await tx.select().from(fieldOptions).where(eq(fieldOptions.fieldId, f.id)).orderBy(asc(fieldOptions.sort));
    result.push({
      id: f.id, key: f.key, label: f.label, cardinality: f.cardinality, builtin: f.builtin, productId: f.productId,
      options: opts.map(optionView),
    });
  }
  return result;
}

async function loadField(tx: Tx, id: string): Promise<FieldRow> {
  const [f] = await tx.select().from(fieldDefinitions).where(eq(fieldDefinitions.id, id));
  if (!f) throw new AppError('not_found', '字段不存在');
  return f;
}

async function requireManage(tx: Tx, actor: Actor, f: FieldRow): Promise<void> {
  if (f.productId) await requireProductRole(tx, actor, f.productId, 'admin');
  else requireOrgAdmin(actor);
}

function assertLabel(label: string): string {
  const l = label.trim();
  if (!l || l.length > 20) throw new AppError('invalid', '选项名称不能为空，且不超过 20 个字符');
  return l;
}

function assertColor(color: string | null | undefined): void {
  if (color && !COLOR_RE.test(color)) throw new AppError('invalid', '颜色格式应为 #RRGGBB');
}

export async function listFields(db: Db, actor: Actor, opts: { productId?: string } = {}): Promise<FieldView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (opts.productId) await requireProductRole(tx, actor, opts.productId, 'viewer');
    else requireNonGuest(actor);
    const rows = await tx
      .select()
      .from(fieldDefinitions)
      .where(
        opts.productId
          ? or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, opts.productId))
          : isNull(fieldDefinitions.productId),
      )
      .orderBy(asc(fieldDefinitions.createdAt));
    const effective = rows.filter((f) => f.productId !== null || !rows.some((o) => o.productId !== null && o.key === f.key));
    return withOptions(tx, effective);
  });
}

export async function addFieldOption(
  db: Db,
  actor: Actor,
  fieldId: string,
  input: { label: string; color?: string | null; key?: string },
): Promise<FieldOptionView> {
  const label = assertLabel(input.label);
  assertColor(input.color);
  if (input.key !== undefined && !OPTION_KEY_RE.test(input.key)) {
    throw new AppError('invalid', '选项 key 只能包含小写字母、数字和下划线，并以字母开头');
  }
  return withOrg(db, actor.orgId, async (tx) => {
    const f = await loadField(tx, fieldId);
    await requireManage(tx, actor, f);
    const existing = await tx.select().from(fieldOptions).where(eq(fieldOptions.fieldId, fieldId));
    try {
      const [row] = await tx
        .insert(fieldOptions)
        .values({
          orgId: actor.orgId,
          fieldId,
          key: input.key ?? `o_${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`,
          label,
          color: input.color ?? null,
          sort: existing.length,
        })
        .returning();
      await recordEvent(tx, { orgId: actor.orgId, productId: f.productId, type: 'field.option_added', subjectType: 'field', subjectId: fieldId, actor, payload: { label } });
      return optionView(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '选项 key 已存在');
      throw e;
    }
  });
}

export async function updateFieldOption(
  db: Db,
  actor: Actor,
  optionId: string,
  input: { label?: string; color?: string | null; active?: boolean },
): Promise<FieldOptionView> {
  assertColor(input.color);
  return withOrg(db, actor.orgId, async (tx) => {
    const [opt] = await tx.select().from(fieldOptions).where(eq(fieldOptions.id, optionId));
    if (!opt) throw new AppError('not_found', '选项不存在');
    const f = await loadField(tx, opt.fieldId);
    await requireManage(tx, actor, f);
    const label = input.label === undefined ? opt.label : assertLabel(input.label);
    const color = input.color === undefined ? opt.color : input.color;
    const active = input.active === undefined ? opt.active : input.active;
    const [row] = await tx
      .update(fieldOptions)
      .set({ label, color, active })
      .where(eq(fieldOptions.id, optionId))
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: f.productId,
      type: 'field.option_updated',
      subjectType: 'field',
      subjectId: f.id,
      actor,
      payload: {
        optionId,
        changes: [
          { field: 'label', old: opt.label, new: label },
          { field: 'color', old: opt.color, new: color },
          { field: 'active', old: opt.active, new: active },
        ].filter((c) => c.old !== c.new),
      },
    });
    return optionView(row!);
  });
}

export async function reorderFieldOptions(db: Db, actor: Actor, fieldId: string, optionIds: string[]): Promise<FieldOptionView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const f = await loadField(tx, fieldId);
    await requireManage(tx, actor, f);
    const existing = await tx.select().from(fieldOptions).where(eq(fieldOptions.fieldId, fieldId));
    const same = existing.length === optionIds.length && existing.every((o) => optionIds.includes(o.id));
    if (!same) throw new AppError('invalid', '排序必须包含该字段的全部选项');
    for (const [i, id] of optionIds.entries()) {
      await tx.update(fieldOptions).set({ sort: i }).where(and(eq(fieldOptions.id, id), eq(fieldOptions.fieldId, fieldId)));
    }
    await recordEvent(tx, { orgId: actor.orgId, productId: f.productId, type: 'field.options_reordered', subjectType: 'field', subjectId: fieldId, actor, payload: { optionIds } });
    const rows = await tx.select().from(fieldOptions).where(eq(fieldOptions.fieldId, fieldId)).orderBy(asc(fieldOptions.sort));
    return rows.map(optionView);
  });
}

export async function forkFieldForProduct(db: Db, actor: Actor, productId: string, orgFieldId: string): Promise<FieldView> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const src = await loadField(tx, orgFieldId);
    if (src.productId) throw new AppError('invalid', '只能复制组织级字段');
    let copy: FieldRow;
    try {
      [copy] = (await tx
        .insert(fieldDefinitions)
        .values({ orgId: actor.orgId, productId, key: src.key, label: src.label, cardinality: src.cardinality, builtin: src.builtin })
        .returning()) as [FieldRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '该产品已覆盖此字段');
      throw e;
    }
    const opts = await tx.select().from(fieldOptions).where(eq(fieldOptions.fieldId, src.id));
    if (opts.length > 0) {
      await tx.insert(fieldOptions).values(
        opts.map((o) => ({ orgId: actor.orgId, fieldId: copy.id, key: o.key, label: o.label, color: o.color, sort: o.sort, active: o.active })),
      );
    }
    await recordEvent(tx, { orgId: actor.orgId, productId, type: 'field.forked', subjectType: 'field', subjectId: copy.id, actor, payload: { from: src.id, key: src.key } });
    const [v] = await withOptions(tx, [copy]);
    return v!;
  });
}
