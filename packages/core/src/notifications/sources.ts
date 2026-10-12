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
import { iterationTasksOverviewTx, overviewTaskOf } from '../tasks/queries';
import { countedRows, overviewRows, todayInZone, workdaysElapsed } from '../tasks/schedule';
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

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 按时区格式化为「MM-DD 周X」。 */
export function dateWithWeekday(d: Date, timeZone: string): string {
  const ymd = todayInZone(timeZone, d);
  return `${ymd.slice(5)} ${WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()]}`;
}

/** 按时区格式化为 HH:mm。 */
export function formatClock(d: Date, timeZone: string): string {
  const p = zoned(d, timeZone);
  return `${p.hh}:${p.mm}`;
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

/** 企微 markdown 的三种字色：info 绿、warning 橙红、comment 灰。 */
export type Tone = 'info' | 'warning' | 'comment';
type Change = { label: string; old: string; new: string; tone: Tone };

export type EventMessageData = {
  product: { key: string; name: string };
  event: { type: string; label: string; tone: Tone; actor: string; time: string };
  subject: { key: string; title: string; url: string };
  changes: Change[];
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

/*
 * 着色规则（企微 markdown 字色）：
 * - 需求状态：按流程状态的类别排先后（backlog < unstarted < started < completed），同类别按状态的 order；
 *   往后为推进（info），往前为退回（warning）；涉及 canceled 类别的不算推进或退回（comment）。
 * - PRD 状态：草稿 < 评审中 < 已通过 < 已上线 / 已合入，同样推进为 info、退回为 warning；废弃、使用中、归档为 comment。
 * - 迭代状态变为已完成、版本发布为 info；检查项签为通过或不需要为 info，签为驳回为 warning。
 * - 需求所属迭代：原来在某个迭代里（移出或换到别的迭代，即延期）为 warning；原来没有迭代为 comment。
 * - 优先级：升到 P0 / P1（新的最高优先级是 P0 / P1，且高于原来的）为 warning。
 * - 其余为 comment。事件的颜色：新建需求、版本发布、检查项签字默认 info，其余默认 comment；
 *   任一改动为 warning 时为 warning，否则任一改动为 info 时为 info。
 */
const STATE_CATEGORY_RANK: Record<string, number> = { backlog: 0, unstarted: 1, started: 2, completed: 3 };
const DOCUMENT_STATUS_RANK: Record<string, number> = { draft: 0, review: 1, approved: 2, launched: 3, merged: 3 };
const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1 };
const EVENT_BASE_TONE: Partial<Record<string, Tone>> = { 'requirement.created': 'info', 'release.released': 'info', 'check_item.signed': 'info' };

const compareTone = (a: number[] | null, b: number[] | null): Tone => {
  if (!a || !b) return 'comment';
  const d = a[0]! - b[0]! || a[1]! - b[1]!;
  return d < 0 ? 'info' : d > 0 ? 'warning' : 'comment';
};

export function eventTone(type: string, changes: Array<{ tone: Tone }>): Tone {
  if (changes.some((c) => c.tone === 'warning')) return 'warning';
  if (changes.some((c) => c.tone === 'info')) return 'info';
  return EVENT_BASE_TONE[type] ?? 'comment';
}

/** 优先级字段的选项 key（payload 里记的是选项名称）。 */
async function priorityKeysTx(tx: Tx, productId: string | null): Promise<Map<string, string>> {
  const rows = await tx
    .select({ key: fieldOptions.key, label: fieldOptions.label })
    .from(fieldOptions)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldOptions.fieldId))
    .where(and(eq(fieldDefinitions.key, 'priority'), productId ? or(eq(fieldDefinitions.productId, productId), isNull(fieldDefinitions.productId)) : isNull(fieldDefinitions.productId)))
    .orderBy(sql`${fieldDefinitions.productId} nulls last`);
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.label)) out.set(r.label, r.key);
  return out;
}

async function changeLinesTx(tx: Tx, ev: EventRow): Promise<Change[]> {
  const raw = Array.isArray(ev.payload.changes) ? (ev.payload.changes as Array<{ field: string; old: unknown; new: unknown }>) : [];
  const out: Change[] = [];
  for (const c of raw) {
    if (c.field === 'stateKey' && ev.productId) {
      const body = await productWorkflowBody(tx, ev.productId);
      const stateOf = (k: unknown) => body.states.find((s) => s.key === k);
      const name = (k: unknown) => (k ? (stateOf(k)?.label ?? String(k)) : '空');
      const rank = (k: unknown) => {
        const st = stateOf(k);
        return st && st.category in STATE_CATEGORY_RANK ? [STATE_CATEGORY_RANK[st.category]!, st.order] : null;
      };
      out.push({ label: '状态', old: name(c.old), new: name(c.new), tone: compareTone(rank(c.old), rank(c.new)) });
    } else if (c.field === 'iterationId') {
      const nameOf = async (id: unknown) =>
        typeof id === 'string' ? ((await tx.select({ name: iterations.name }).from(iterations).where(eq(iterations.id, id)))[0]?.name ?? '已删除的迭代') : '空';
      const named = typeof ev.payload.iterationName === 'string' ? ev.payload.iterationName : null;
      out.push({ label: '迭代', old: await nameOf(c.old), new: named ?? (await nameOf(c.new)), tone: c.old ? 'warning' : 'comment' });
    } else if (c.field === 'status') {
      const labels: Record<string, string> =
        ev.subjectType === 'document' ? DOCUMENT_STATUS_LABELS : ev.subjectType === 'iteration' ? ITERATION_STATUS_LABELS : RELEASE_STATUS_LABELS;
      const docRank = (v: unknown) => (String(v) in DOCUMENT_STATUS_RANK ? [DOCUMENT_STATUS_RANK[String(v)]!, 0] : null);
      const tone: Tone =
        ev.subjectType === 'document'
          ? compareTone(docRank(c.old), docRank(c.new))
          : (ev.subjectType === 'iteration' && c.new === 'done') || (ev.subjectType === 'release' && c.new === 'released')
            ? 'info'
            : 'comment';
      out.push({ label: '状态', old: labels[String(c.old)] ?? valueText(c.old), new: labels[String(c.new)] ?? valueText(c.new), tone });
    } else if (c.field === 'assignments') {
      const a = (c.new ?? {}) as { memberId?: string; functionTagId?: string };
      const [m] = a.memberId ? await tx.select({ name: members.displayName }).from(members).where(eq(members.id, a.memberId)) : [];
      const [tag] = a.functionTagId ? await tx.select({ name: functionTags.name }).from(functionTags).where(eq(functionTags.id, a.functionTagId)) : [];
      out.push({ label: '分配', old: '空', new: [m?.name, tag?.name].filter(Boolean).join(' · ') || '空', tone: 'comment' });
    } else if (c.field === 'state') {
      const labels = CHECK_STATE_LABELS as Record<string, string>;
      const tone: Tone = c.new === 'passed' || c.new === 'not_needed' ? 'info' : c.new === 'rejected' ? 'warning' : 'comment';
      out.push({ label: `检查项「${String(ev.payload.itemKey ?? '')}」`, old: labels[String(c.old)] ?? valueText(c.old), new: labels[String(c.new)] ?? valueText(c.new), tone });
    } else if (ev.type === 'requirement.field_changed') {
      const [f] = await tx
        .select({ label: fieldDefinitions.label })
        .from(fieldDefinitions)
        .where(and(eq(fieldDefinitions.key, c.field), ev.productId ? or(eq(fieldDefinitions.productId, ev.productId), isNull(fieldDefinitions.productId)) : isNull(fieldDefinitions.productId)))
        .orderBy(sql`${fieldDefinitions.productId} nulls last`)
        .limit(1);
      let tone: Tone = 'comment';
      if (c.field === 'priority') {
        const keys = await priorityKeysTx(tx, ev.productId);
        const best = (v: unknown) => Math.min(99, ...(Array.isArray(v) ? v : []).map((l) => PRIORITY_RANK[keys.get(String(l)) ?? ''] ?? 99));
        if (best(c.new) <= 1 && best(c.new) < best(c.old)) tone = 'warning';
      }
      out.push({ label: f?.label ?? c.field, old: valueText(c.old), new: valueText(c.new), tone });
    } else {
      out.push({ label: c.field, old: valueText(c.old), new: valueText(c.new), tone: 'comment' });
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
    event: { type: ev.type, label, tone: eventTone(ev.type, changes), actor: actor?.name ?? '系统', time: formatMinute(ev.occurredAt, ctx.timeZone) },
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

/** 按字符截断，超出时以「…」结尾，结果不超过 max 个字符（企微卡片的建议长度）。 */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 企微文本通知卡片的建议长度：主标题 26、辅助信息 30、关键数据 10 / 说明 15；引用区每行 40。 */
export const CARD_LIMITS = { title: 26, desc: 30, emphasisTitle: 10, emphasisDesc: 15, quoteLine: 40 } as const;

/** 「{前缀} · YYYY-MM-DD」：前缀（产品名或自定义标题，用户可改）按剩余长度截断。 */
const cardTitle = (prefix: string, date: string): string => {
  const tail = ` · ${date}`;
  return `${clip(prefix, CARD_LIMITS.title - tail.length)}${tail}`;
};

/** 发版信息：发版日在今天之后为「MM/DD 发版 · 还剩 N 个工作日」（N 为明天到发版日的工作日数，含发版日）。 */
export function releaseText(endDate: string, today: string): string {
  if (endDate === today) return '今天发版';
  if (endDate < today) return '已过发版日';
  return `${endDate.slice(5, 7)}/${endDate.slice(8, 10)} 发版 · 还剩 ${workdaysElapsed(today, endDate)} 个工作日`;
}

/**
 * 概览卡片的数据。title、desc、button 供自建卡片模板沿用；预置模板另用 source、emphasis、stats、quote、jumps，
 * 其中可选区块为现成对象或 null（null 时卡片去掉该键）。
 */
export async function overviewCardDataTx(tx: Tx, s: ScheduleRow, ctx: OrgContext, now: Date): Promise<Record<string, unknown>> {
  const product = await productOf(tx, s);
  const cfg = s.sourceConfig as OverviewCardConfig;
  const title = cardTitle(cfg.titlePrefix || `${product.name} 研发日报`, todayInZone(s.timezone, now));
  const its = await tx
    .select()
    .from(iterations)
    .where(and(eq(iterations.productId, product.id), eq(iterations.type, 'regular'), isNull(iterations.deletedAt), ne(iterations.status, 'canceled')));
  const it = pickIteration(its);
  if (!it) {
    const url = `${ctx.base}/iterations`;
    return {
      title,
      desc: '当前没有迭代 · 点开查看迭代列表',
      button: { title: '查看迭代列表', url },
      source: { desc: 'Flower · 研发日报', desc_color: 0 },
      emphasis: null,
      stats: null,
      quote: null,
      jumps: [{ type: 1, title: '查看迭代列表', url }],
      product,
      iteration: null,
      overall: null,
    };
  }
  // 与甘特页同一口径：同一取数与计算，「今天」按组织时区
  const today = await orgToday(tx, ctx.orgId, now);
  const { tasks, overview } = await iterationTasksOverviewTx(tx, null, it, [product.id], today);
  const behindRows = countedRows(overviewRows(tasks.map(overviewTaskOf), today)).filter((r) => r.progress < overview.expected).length;
  const release = releaseText(it.endDate, today);
  const desc = `${clip(it.name, CARD_LIMITS.desc - ` · ${release}`.length)} · ${release}`;
  const ganttUrl = `${ctx.base}/iterations/${it.id}?tab=gantt`;
  const attention = overview.attention.slice(0, 3).map((a) => clip([a.title, a.assignees.join('、'), a.note].filter(Boolean).join(' · '), CARD_LIMITS.quoteLine));
  return {
    title,
    desc,
    button: { title: '查看甘特', url: ganttUrl },
    source: { desc: 'Flower · 研发日报', desc_color: overview.behind > 0 ? 2 : 3 },
    emphasis: { title: `${overview.overall}%`, desc: `整体进度（理论 ${overview.expected}%）` },
    stats: [
      { keyname: '需求', value: `${overview.rowCount} 项` },
      { keyname: '落后', value: `${behindRows} 项` },
      { keyname: '遗留下期', value: `${overview.deferred} 项` },
    ],
    quote: attention.length ? { type: 0, title: '需要关注', quote_text: attention.join('\n') } : null,
    jumps: [
      { type: 1, title: '查看甘特', url: ganttUrl },
      { type: 1, title: '需求列表', url: `${ctx.base}/requirements?product=${product.key}&iteration=${it.id}` },
    ],
    product,
    iteration: { name: it.name, startDate: it.startDate, endDate: it.endDate, status: it.status },
    overall: overview.overall,
    expected: overview.expected,
    behindRows,
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
      urgent: !!pr && (pr.key === 'p0' || pr.key === 'p1'),
      priorityColor: pr && (pr.key === 'p0' || pr.key === 'p1') ? 'warning' : 'comment',
      meta: [people.find((p) => p.id === r.requesterMemberId)?.name ?? '—', opts(r.id, 'line')[0]?.label ?? '—', ...(platforms.length ? [platforms.join('/')] : [])].join(' · '),
      brief: briefOf(r.description),
      prdUrl: doc ? (doc.source === 'external' ? (doc.externalUrl ?? '') : `${ctx.base}/documents/${documentDisplayKey(product.key, doc.number)}`) : '',
    };
  });
  const normal = items.filter((i) => !i.online);
  const online = items.filter((i) => i.online);
  let index = 0;
  const numbered = (list: typeof items) => list.map(({ online: _online, urgent: _urgent, ...rest }) => ({ index: ++index, ...rest }));
  const urgentCount = items.filter((i) => i.urgent).length;
  const color = (n: number) => (n > 0 ? 'warning' : 'comment');
  return {
    product,
    date: shortDate(now, s.timezone),
    dateLabel: dateWithWeekday(now, s.timezone),
    newCount: normal.length,
    onlineCount: online.length,
    urgentCount,
    colors: { newCount: color(normal.length), onlineCount: color(online.length), urgentCount: color(urgentCount) },
    sections: [
      { title: '🆕 新增需求', items: numbered(normal) },
      { title: '🔧 线上转需求', items: numbered(online) },
    ].filter((x) => x.items.length > 0),
    listUrl: `${ctx.base}/requirements?product=${product.key}`,
  };
}

/** 摘要条目按主体分组（按出现顺序），组内按时间列出；每行带事件的颜色与改动（text 供自建模板沿用）。 */
export async function digestDataTx(
  tx: Tx,
  s: ScheduleRow,
  items: Array<{ eventId: string; createdAt: Date }>,
  ctx: OrgContext,
  now: Date,
): Promise<Record<string, unknown>> {
  const product = await productOf(tx, s);
  const sorted = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const datas: EventMessageData[] = [];
  for (const it of sorted) datas.push(await eventMessageDataTx(tx, it.eventId, ctx));
  const groups = new Map<string, EventMessageData[]>();
  for (const d of datas) groups.set(d.subjectRef, [...(groups.get(d.subjectRef) ?? []), d]);
  const times = datas.map((d) => d.occurredAt.getTime());
  return {
    product,
    time: formatClock(now, s.timezone),
    period: `${formatMinute(new Date(Math.min(...times)), ctx.timeZone)} – ${formatMinute(new Date(Math.max(...times)), ctx.timeZone)}`,
    eventCount: datas.length,
    subjectCount: groups.size,
    groups: [...groups.values()].map((g) => ({
      key: g[0]!.subject.key,
      title: g[0]!.subject.title,
      url: g[0]!.subject.url,
      lines: g.map((d) => ({
        text: `${d.event.time} ${d.event.actor}：${d.event.label}${d.changes.length ? `：${d.summary}` : ''}`,
        label: d.event.label,
        tone: d.event.tone,
        actor: d.event.actor,
        time: d.event.time,
        changes: d.changes,
      })),
    })),
  };
}
