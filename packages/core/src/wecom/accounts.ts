import { and, asc, eq, ne } from 'drizzle-orm';
import { baseProductRole, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { members, productMembers } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { WECOM_USERID_RE } from '../notifications/constants';
import { canViewUnlinked } from '../tracking/access';

export const WECOM_USERID_FORMAT = '企业微信账号格式不正确：1–64 位字母、数字或 _ . @ -';
const MAX_CSV_CHARS = 200_000;
const MAX_ROWS = 2000;

export type WecomVia = 'manual' | 'import' | 'oauth' | 'self';

function normalizeUserid(raw: string | null): string | null {
  const v = raw?.trim() ?? '';
  if (!v) return null;
  if (!WECOM_USERID_RE.test(v)) throw new AppError('invalid', WECOM_USERID_FORMAT);
  return v;
}

/** 写入一个成员的企业微信账号（在调用方的事务里）。同一组织内重复时报冲突并带上已绑定成员的姓名。 */
export async function writeWecomUseridTx(tx: Tx, actor: Actor, memberId: string, raw: string | null, via: WecomVia): Promise<{ memberId: string; wecomUserid: string | null }> {
  const userid = normalizeUserid(raw);
  const [cur] = await tx.select({ kind: members.kind, wecomUserid: members.wecomUserid }).from(members).where(eq(members.id, memberId)).for('update');
  if (!cur) throw new AppError('not_found', '成员不存在');
  if (userid && cur.kind !== 'human') throw new AppError('invalid', 'Agent 成员不能绑定企业微信账号');
  if (cur.wecomUserid === userid) return { memberId, wecomUserid: userid };
  if (userid) {
    const [other] = await tx
      .select({ name: members.displayName })
      .from(members)
      .where(and(eq(members.wecomUserid, userid), ne(members.id, memberId)));
    if (other) throw new AppError('conflict', `该企业微信账号已绑定到 ${other.name}`);
  }
  try {
    await tx.update(members).set({ wecomUserid: userid }).where(eq(members.id, memberId));
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '该企业微信账号已绑定到其他成员');
    throw e;
  }
  await recordEvent(tx, {
    orgId: actor.orgId,
    type: 'member.wecom_changed',
    subjectType: 'member',
    subjectId: memberId,
    actor,
    payload: { via, changes: [{ field: 'wecomUserid', old: cur.wecomUserid, new: userid }] },
  });
  return { memberId, wecomUserid: userid };
}

export async function setMemberWecomUserid(db: Db, actor: Actor, memberId: string, userid: string | null): Promise<{ memberId: string; wecomUserid: string | null }> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, (tx) => writeWecomUseridTx(tx, actor, memberId, userid, 'manual'));
}

export async function unbindMyWecom(db: Db, actor: Actor): Promise<void> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能解除企业微信绑定');
  await withOrg(db, actor.orgId, (tx) => writeWecomUseridTx(tx, actor, actor.memberId, null, 'self'));
}

// ---------- CSV 导入 ----------

export type WecomCsvRow = { line: number; email: string; userid: string };
export type WecomImportStatus = 'ok' | 'unchanged' | 'not_found' | 'duplicate' | 'invalid';
export type WecomImportRow = WecomCsvRow & { status: WecomImportStatus; memberId: string | null; memberName: string | null; note: string | null };
export type WecomImportResult = { rows: WecomImportRow[]; counts: Record<WecomImportStatus, number>; applied: number };

const unquote = (cell: string): string => cell.trim().replace(/^"(.*)"$/, '$1').trim();

/**
 * 两列 CSV（邮箱, 企业微信账号）：去 BOM，按行拆分，逗号、中文逗号或制表符分列，去掉引号与空行；
 * 第一行（第一个非空行）第一列不含 @ 时视为表头。行号从 1 开始，按原文件计。
 */
export function parseWecomCsv(csv: string): WecomCsvRow[] {
  if (csv.length > MAX_CSV_CHARS) throw new AppError('invalid', 'CSV 文件过大（最多 200 KB）');
  const rows: WecomCsvRow[] = [];
  let first = true;
  csv
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      const [email = '', userid = ''] = raw.split(/[,，\t]/).map(unquote);
      const header = first && !email.includes('@');
      first = false;
      if (header) return;
      rows.push({ line: i + 1, email: email.toLowerCase(), userid });
    });
  if (rows.length > MAX_ROWS) throw new AppError('invalid', '一次最多导入 2000 行');
  return rows;
}

const emptyCounts = (): Record<WecomImportStatus, number> => ({ ok: 0, unchanged: 0, not_found: 0, duplicate: 0, invalid: 0 });

async function planImportTx(tx: Tx, rows: WecomCsvRow[]): Promise<WecomImportRow[]> {
  const all = await tx
    .select({ id: members.id, displayName: members.displayName, email: members.email, status: members.status, kind: members.kind, wecomUserid: members.wecomUserid })
    .from(members);
  const byEmail = new Map(all.filter((m) => m.email && m.kind === 'human' && m.status === 'active').map((m) => [m.email!.toLowerCase(), m]));
  const byUserid = new Map(all.filter((m) => m.wecomUserid).map((m) => [m.wecomUserid!, m]));
  const seenUserid = new Map<string, number>();
  const seenMember = new Set<string>();
  return rows.map((r): WecomImportRow => {
    const base = { ...r, memberId: null, memberName: null, note: null };
    if (!r.email || !r.userid) return { ...base, status: 'invalid', note: '邮箱与企业微信账号都不能为空' };
    if (!WECOM_USERID_RE.test(r.userid)) return { ...base, status: 'invalid', note: WECOM_USERID_FORMAT };
    const m = byEmail.get(r.email);
    if (!m) return { ...base, status: 'not_found', note: '找不到该邮箱的在职成员' };
    const matched = { ...base, memberId: m.id, memberName: m.displayName };
    if (seenMember.has(m.id)) return { ...matched, status: 'duplicate', note: '文件中该成员重复出现' };
    const holder = byUserid.get(r.userid);
    if (holder && holder.id !== m.id) return { ...matched, status: 'duplicate', note: `该企业微信账号已绑定到 ${holder.displayName}` };
    const firstLine = seenUserid.get(r.userid);
    if (firstLine !== undefined) return { ...matched, status: 'duplicate', note: `与第 ${firstLine} 行的企业微信账号重复` };
    // 只有被采纳（可匹配或无变化）的行才占用成员与账号，被拒绝的行不影响后面的行
    seenMember.add(m.id);
    seenUserid.set(r.userid, r.line);
    if (m.wecomUserid === r.userid) return { ...matched, status: 'unchanged' };
    return { ...matched, status: 'ok', note: m.wecomUserid ? `将替换原账号 ${m.wecomUserid}` : null };
  });
}

function summarize(rows: WecomImportRow[], applied: number): WecomImportResult {
  const counts = emptyCounts();
  for (const r of rows) counts[r.status] += 1;
  return { rows, counts, applied };
}

export async function previewWecomImport(db: Db, actor: Actor, csv: string): Promise<WecomImportResult> {
  requireOrgAdmin(actor);
  const rows = parseWecomCsv(csv);
  return withOrg(db, actor.orgId, async (tx) => summarize(await planImportTx(tx, rows), 0));
}

/** 确认导入：在同一事务里重新计算，只写「可匹配」的行。 */
export async function applyWecomImport(db: Db, actor: Actor, csv: string): Promise<WecomImportResult> {
  requireOrgAdmin(actor);
  const rows = parseWecomCsv(csv);
  return withOrg(db, actor.orgId, async (tx) => {
    const planned = await planImportTx(tx, rows);
    let applied = 0;
    for (const r of planned) {
      if (r.status !== 'ok') continue;
      await writeWecomUseridTx(tx, actor, r.memberId!, r.userid, 'import');
      applied += 1;
    }
    return summarize(planned, applied);
  });
}

// ---------- @ 候选成员 ----------

export type MentionMember = { id: string; displayName: string; email: string | null; status: 'active' | 'left'; wecomBound: boolean; canSeeProduct: boolean };

/**
 * 组织的全部真人成员（含已离开，用于显示灰色原名）；能否看到该产品按组织角色与产品角色计算。
 * productId 为 null 时用于不关联产品的工作项：能看到 = 在职的非访客；访客不能读取（403）。访客调用时不返回邮箱。
 */
export async function listMentionMembers(db: Db, actor: Actor, productId: string | null): Promise<MentionMember[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (productId) await requireProductRole(tx, actor, productId, 'viewer');
    else if (!canViewUnlinked(actor)) throw new AppError('forbidden', '访客无权查看此内容');
    const rows = await tx
      .select({ id: members.id, displayName: members.displayName, email: members.email, status: members.status, orgRole: members.orgRole, wecomUserid: members.wecomUserid })
      .from(members)
      .where(eq(members.kind, 'human'))
      .orderBy(asc(members.displayName));
    const roles = productId ? await tx.select({ memberId: productMembers.memberId, role: productMembers.role }).from(productMembers).where(eq(productMembers.productId, productId)) : [];
    const roleOf = new Map(roles.map((r) => [r.memberId, r.role]));
    const hideEmail = actor.orgRole === 'guest';
    return rows.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      email: hideEmail ? null : m.email,
      status: m.status,
      wecomBound: m.wecomUserid !== null,
      canSeeProduct: m.status === 'active' && (productId ? baseProductRole(m.orgRole, roleOf.get(m.id) ?? null) !== null : m.orgRole !== 'guest'),
    }));
  });
}
