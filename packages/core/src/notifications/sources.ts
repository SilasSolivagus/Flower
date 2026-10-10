import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  documents,
  domainEvents,
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  functionTags,
  iterations,
  members,
  organizations,
  products,
  releases,
  requirements,
} from '../db/schema';
import type { Tx } from '../db/tx';
import { DOCUMENT_STATUS_LABELS, documentDisplayKey } from '../documents/markdown';
import { AppError } from '../errors';
import { ITERATION_STATUS_LABELS } from '../iterations/iterations';
import { productWorkflowBody } from '../requirements/context';
import { CHECK_STATE_LABELS } from '../requirements/labels';
import { displayKey } from '../requirements/requirements';
import { iterationTasksOverviewTx } from '../tasks/queries';
import { todayInZone } from '../tasks/schedule';
import { orgToday } from '../tasks/tasks';
import { EVENT_TYPE_LABELS, isNotifiableEventType, type NewRequirementsConfig, type OverviewCardConfig, SCHEDULE_DEFAULT_TIMEZONE } from './constants';
import { parseSourceConfig, type ScheduleRow } from './schedules';

export type OrgContext = { orgId: string; slug: string; name: string; timeZone: string; base: string };

const validZone = (tz: string | undefined): string | null => {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};

export async function orgContextTx(tx: Tx, orgId: string, publicUrl: string): Promise<OrgContext> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new AppError('not_found', '组织不存在');
  return {
    orgId,
    slug: org.slug,
    name: org.name,
    timeZone: validZone(org.settings.timezone) ?? SCHEDULE_DEFAULT_TIMEZONE,
    base: `${publicUrl.replace(/\/+$/, '')}/${org.slug}`,
  };
}

function zoned(d: Date, timeZone: string): { m: string; d: string; hh: string; mm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { m: parts.month!, d: parts.day!, hh: parts.hour!, mm: parts.minute! };
}

/** 按时区格式化为 MM-DD HH:mm。 */
export function formatMinute(d: Date, timeZone: string): string {
  const p = zoned(d, timeZone);
  return `${p.m}-${p.d} ${p.hh}:${p.mm}`;
}

/** 按时区格式化为 M/D（push 新需求标题的写法）。 */
export function shortDate(d: Date, timeZone: string): string {
  const p = zoned(d, timeZone);
  return `${Number(p.m)}/${Number(p.d)}`;
}

const valueText = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '空';
  if (Array.isArray(v)) return v.length ? v.map(valueText).join('、') : '空';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const RELEASE_STATUS_LABELS: Record<string, string> = { planned: '计划中', released: '已发布' };

export type EventMessageData = {
  product: { key: string; name: string };
  event: { type: string; label: string; actor: string; time: string };
  subject: { key: string; title: string; url: string };
  changes: Array<{ label: string; old: string; new: string }>;
  summary: string;
  occurredAt: Date;
  subjectRef: string;
};

type EventRow = typeof domainEvents.$inferSelect;

async function subjectTx(tx: Tx, ev: EventRow, productKey: string, ctx: OrgContext): Promise<EventMessageData['subject']> {
  if (ev.subjectType === 'requirement') {
    const [r] = await tx.select({ number: requirements.number, title: requirements.title }).from(requirements).where(eq(requirements.id, ev.subjectId));
    if (r) {
      const key = displayKey(productKey, r.number);
      return { key, title: r.title, url: `${ctx.base}/requirements/${key}` };
    }
  }
  if (ev.subjectType === 'document') {
    const [d] = await tx.select({ number: documents.number, title: documents.title }).from(documents).where(eq(documents.id, ev.subjectId));
    if (d) {
      const key = documentDisplayKey(productKey, d.number);
      return { key, title: d.title, url: `${ctx.base}/documents/${key}` };
    }
  }
  if (ev.subjectType === 'iteration') {
    const [i] = await tx.select({ name: iterations.name }).from(iterations).where(eq(iterations.id, ev.subjectId));
    if (i) return { key: '迭代', title: i.name, url: `${ctx.base}/iterations/${ev.subjectId}` };
  }
  if (ev.subjectType === 'release') {
    const [r] = await tx.select({ name: releases.versionName }).from(releases).where(eq(releases.id, ev.subjectId));
    if (r) return { key: '版本', title: r.name, url: `${ctx.base}/iterations` };
  }
  return { key: '', title: '', url: ctx.base };
}

async function changeLinesTx(tx: Tx, ev: EventRow): Promise<EventMessageData['changes']> {
  const raw = Array.isArray(ev.payload.changes) ? (ev.payload.changes as Array<{ field: string; old: unknown; new: unknown }>) : [];
  const out: EventMessageData['changes'] = [];
  for (const c of raw) {
    if (c.field === 'stateKey' && ev.productId) {
      const body = await productWorkflowBody(tx, ev.productId);
      const name = (k: unknown) => (k ? (body.states.find((s) => s.key === k)?.label ?? String(k)) : '空');
      out.push({ label: '状态', old: name(c.old), new: name(c.new) });
    } else if (c.field === 'iterationId') {
      const nameOf = async (id: unknown) =>
        typeof id === 'string' ? ((await tx.select({ name: iterations.name }).from(iterations).where(eq(iterations.id, id)))[0]?.name ?? '已删除的迭代') : '空';
      const named = typeof ev.payload.iterationName === 'string' ? ev.payload.iterationName : null;
      out.push({ label: '迭代', old: await nameOf(c.old), new: named ?? (await nameOf(c.new)) });
    } else if (c.field === 'status') {
      const labels: Record<string, string> =
        ev.subjectType === 'document' ? DOCUMENT_STATUS_LABELS : ev.subjectType === 'iteration' ? ITERATION_STATUS_LABELS : RELEASE_STATUS_LABELS;
      out.push({ label: '状态', old: labels[String(c.old)] ?? valueText(c.old), new: labels[String(c.new)] ?? valueText(c.new) });
    } else if (c.field === 'assignments') {
      const a = (c.new ?? {}) as { memberId?: string; functionTagId?: string };
      const [m] = a.memberId ? await tx.select({ name: members.displayName }).from(members).where(eq(members.id, a.memberId)) : [];
      const [tag] = a.functionTagId ? await tx.select({ name: functionTags.name }).from(functionTags).where(eq(functionTags.id, a.functionTagId)) : [];
      out.push({ label: '分配', old: '空', new: [m?.name, tag?.name].filter(Boolean).join(' · ') || '空' });
    } else if (c.field === 'state') {
      const labels = CHECK_STATE_LABELS as Record<string, string>;
      out.push({ label: `检查项「${String(ev.payload.itemKey ?? '')}」`, old: labels[String(c.old)] ?? valueText(c.old), new: labels[String(c.new)] ?? valueText(c.new) });
    } else if (ev.type === 'requirement.field_changed') {
      const [f] = await tx
        .select({ label: fieldDefinitions.label })
        .from(fieldDefinitions)
        .where(and(eq(fieldDefinitions.key, c.field), ev.productId ? or(eq(fieldDefinitions.productId, ev.productId), isNull(fieldDefinitions.productId)) : isNull(fieldDefinitions.productId)))
        .orderBy(sql`${fieldDefinitions.productId} nulls last`)
        .limit(1);
      out.push({ label: f?.label ?? c.field, old: valueText(c.old), new: valueText(c.new) });
    } else {
      out.push({ label: c.field, old: valueText(c.old), new: valueText(c.new) });
    }
  }
  return out;
}

export async function eventMessageDataTx(tx: Tx, eventId: string, ctx: OrgContext): Promise<EventMessageData> {
  const [ev] = await tx.select().from(domainEvents).where(eq(domainEvents.id, eventId));
  if (!ev) throw new AppError('not_found', '事件不存在');
  const [product] = ev.productId ? await tx.select({ key: products.key, name: products.name }).from(products).where(eq(products.id, ev.productId)) : [];
  const [actor] = ev.actorMemberId ? await tx.select({ name: members.displayName }).from(members).where(eq(members.id, ev.actorMemberId)) : [];
  const label = isNotifiableEventType(ev.type) ? EVENT_TYPE_LABELS[ev.type] : ev.type;
  const changes = await changeLinesTx(tx, ev);
  return {
    product: product ?? { key: '', name: ctx.name },
    event: { type: ev.type, label, actor: actor?.name ?? '系统', time: formatMinute(ev.occurredAt, ctx.timeZone) },
    subject: await subjectTx(tx, ev, product?.key ?? '', ctx),
    changes,
    summary: changes.length ? changes.map((c) => `${c.label} ${c.old} → ${c.new}`).join('；') : label,
    occurredAt: ev.occurredAt,
    subjectRef: `${ev.subjectType}:${ev.subjectId}`,
  };
}

async function productOf(tx: Tx, s: ScheduleRow): Promise<{ id: string; key: string; name: string }> {
  const [p] = await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, s.productId!));
  if (!p) throw new AppError('not_found', '定时推送的产品不存在');
  return p;
}

/** 本产品的当前迭代：进行中（结束日最早）→ 规划中（开始日最早）→ 已完成（结束日最晚）。 */
function pickIteration<T extends { status: string; startDate: string; endDate: string }>(its: T[]): T | undefined {
  const by = (status: string, cmp: (a: T, b: T) => number) => its.filter((i) => i.status === status).sort(cmp)[0];
  return (
    by('active', (a, b) => a.endDate.localeCompare(b.endDate)) ??
    by('planning', (a, b) => a.startDate.localeCompare(b.startDate)) ??
    by('done', (a, b) => b.endDate.localeCompare(a.endDate))
  );
}

export async function overviewCardDataTx(tx: Tx, s: ScheduleRow, ctx: OrgContext, now: Date): Promise<Record<string, unknown>> {
  const product = await productOf(tx, s);
  const cfg = s.sourceConfig as OverviewCardConfig;
  const title = `${cfg.titlePrefix || `${product.name} 研发日报`} · ${todayInZone(s.timezone, now)}`;
  const its = await tx
    .select()
    .from(iterations)
    .where(and(eq(iterations.productId, product.id), eq(iterations.type, 'regular'), isNull(iterations.deletedAt), ne(iterations.status, 'canceled')));
  const it = pickIteration(its);
  if (!it) return { title, desc: '当前没有迭代 · 点开查看迭代列表', button: { title: '查看迭代列表', url: `${ctx.base}/iterations` }, product, iteration: null, overall: null };
  // 与甘特页同一口径：同一取数与计算，「今天」按组织时区
  const { overview } = await iterationTasksOverviewTx(tx, null, it, [product.id], await orgToday(tx, ctx.orgId, now));
  const mmdd = `${it.endDate.slice(5, 7)}${it.endDate.slice(8, 10)}`;
  return {
    title,
    desc: `${mmdd} 发版 · 整体进度 ${overview.overall}% · 点开查看需求与甘特`,
    button: { title: '查看完整明细', url: `${ctx.base}/iterations/${it.id}` },
    product,
    iteration: { name: it.name, startDate: it.startDate, endDate: it.endDate, status: it.status },
    overall: overview.overall,
    expected: overview.expected,
  };
}

/** 需求说明：描述里第一行不是标题的文字，去掉开头的引用、列表标记，最多 80 字。 */
const briefOf = (description: string): string => {
  const line = description
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  const text = (line ?? '').replace(/^[>*\-\s]+/, '').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

/** 时间窗内新建的需求（push 新需求的版式数据）；没有时返回 null。 */
export async function newRequirementsDataTx(tx: Tx, s: ScheduleRow, ctx: OrgContext, now: Date): Promise<Record<string, unknown> | null> {
  const product = await productOf(tx, s);
  const cfg = parseSourceConfig('new_requirements', s.sourceConfig) as NewRequirementsConfig;
  const since = s.lastSuccessAt ?? new Date(now.getTime() - 24 * 3600_000);
  const rows = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.productId, product.id), isNull(requirements.deletedAt), gt(requirements.createdAt, since), lte(requirements.createdAt, now)))
    .orderBy(asc(requirements.number));
  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);
  const values = await tx
    .select({ entityId: fieldValues.entityId, field: fieldDefinitions.key, key: fieldOptions.key, label: fieldOptions.label })
    .from(fieldValues)
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .where(and(inArray(fieldValues.entityId, ids), inArray(fieldDefinitions.key, ['priority', 'line', 'platform', 'source'])))
    .orderBy(asc(fieldOptions.sort));
  const opts = (id: string, field: string) => values.filter((v) => v.entityId === id && v.field === field);
  const requesterIds = [...new Set(rows.map((r) => r.requesterMemberId).filter((x): x is string => !!x))];
  const people = requesterIds.length ? await tx.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, requesterIds)) : [];
  const docIds = [...new Set(rows.map((r) => r.changeDocumentId).filter((x): x is string => !!x))];
  const docs = docIds.length
    ? await tx.select({ id: documents.id, number: documents.number, source: documents.source, externalUrl: documents.externalUrl }).from(documents).where(inArray(documents.id, docIds))
    : [];
  const items = rows.map((r) => {
    const key = displayKey(product.key, r.number);
    const pr = opts(r.id, 'priority')[0];
    const platforms = opts(r.id, 'platform').map((v) => v.label);
    const doc = docs.find((d) => d.id === r.changeDocumentId);
    return {
      online: opts(r.id, 'source').some((v) => cfg.onlineSourceKeys.includes(v.key)),
      key,
      title: r.title,
      url: `${ctx.base}/requirements/${key}`,
      priority: pr?.label ?? '—',
      priorityColor: pr && (pr.key === 'p0' || pr.key === 'p1') ? 'warning' : 'comment',
      meta: [people.find((p) => p.id === r.requesterMemberId)?.name ?? '—', opts(r.id, 'line')[0]?.label ?? '—', ...(platforms.length ? [platforms.join('/')] : [])].join(' · '),
      brief: briefOf(r.description),
      prdUrl: doc ? (doc.source === 'external' ? (doc.externalUrl ?? '') : `${ctx.base}/documents/${documentDisplayKey(product.key, doc.number)}`) : '',
    };
  });
  const normal = items.filter((i) => !i.online);
  const online = items.filter((i) => i.online);
  let index = 0;
  const numbered = (list: typeof items) => list.map(({ online: _online, ...rest }) => ({ index: ++index, ...rest }));
  return {
    product,
    date: shortDate(now, s.timezone),
    newCount: normal.length,
    onlineCount: online.length,
    sections: [
      { title: '🆕 新增需求', items: numbered(normal) },
      { title: '🔧 线上转需求', items: numbered(online) },
    ].filter((x) => x.items.length > 0),
    listUrl: `${ctx.base}/requirements?product=${product.key}`,
  };
}

/** 摘要条目按主体分组（按出现顺序），组内按时间列出。 */
export async function digestDataTx(tx: Tx, s: ScheduleRow, items: Array<{ eventId: string; createdAt: Date }>, ctx: OrgContext): Promise<Record<string, unknown>> {
  const product = await productOf(tx, s);
  const sorted = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const datas: EventMessageData[] = [];
  for (const it of sorted) datas.push(await eventMessageDataTx(tx, it.eventId, ctx));
  const groups = new Map<string, EventMessageData[]>();
  for (const d of datas) groups.set(d.subjectRef, [...(groups.get(d.subjectRef) ?? []), d]);
  const times = datas.map((d) => d.occurredAt.getTime());
  return {
    product,
    period: `${formatMinute(new Date(Math.min(...times)), ctx.timeZone)} – ${formatMinute(new Date(Math.max(...times)), ctx.timeZone)}`,
    eventCount: datas.length,
    subjectCount: groups.size,
    groups: [...groups.values()].map((g) => ({
      key: g[0]!.subject.key,
      title: g[0]!.subject.title,
      url: g[0]!.subject.url,
      lines: g.map((d) => ({ text: `${d.event.time} ${d.event.actor}：${d.event.label}${d.changes.length ? `：${d.summary}` : ''}` })),
    })),
  };
}
