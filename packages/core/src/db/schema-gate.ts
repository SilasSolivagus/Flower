import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/** 版本闸连库超时（秒）。postgres.js 默认 30 秒，且初次连接失败会按退避重连。 */
export const CONNECT_TIMEOUT_SEC = 10;
/** 整个 --check 的上限（毫秒），到点退出，不把重连留给进程。 */
export const CHECK_BUDGET_MS = 30_000;

const SCHEMA_CMD = 'docker compose --profile schema run --rm schema';
const MAYBE_SCHEMA = `可能还没迁移，先跑 ${SCHEMA_CMD}`;

const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CHECK_BUDGET',
]);

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

export type JournalEntry = { idx: number; when: number; tag: string };

export type AppliedMigration = { createdAt: number };

export type CompareResult =
  | { status: 'ok'; latestTag: string }
  | { status: 'missing' }
  | { status: 'behind'; dbLabel: string; imageLabel: string }
  | { status: 'ahead'; dbLabel: string; imageLabel: string }
  | { status: 'count-mismatch'; appliedCount: number; expectedCount: number };

export type DbTarget = { host: string; port: string; user: string };

/** 解析连接串里的主机、端口、账号。没有主机名就返回 null，避免驱动把主机缺省到本机。 */
export function dbTarget(url: string): DbTarget | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname || !parsed.username) return null;
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      user: decodeURIComponent(parsed.username),
    };
  } catch {
    return null;
  }
}

export function readJournal(migrationsDir: string): JournalEntry[] {
  const file = path.join(migrationsDir, 'meta', '_journal.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries?: JournalEntry[] };
  if (!Array.isArray(raw.entries)) throw new GateError('镜像内迁移清单无法读取');
  return raw.entries.map((entry) => ({ idx: entry.idx, when: entry.when, tag: entry.tag }));
}

function latestEntry(journal: JournalEntry[]): JournalEntry | undefined {
  return journal.reduce<JournalEntry | undefined>((best, entry) => (!best || entry.when > best.when ? entry : best), undefined);
}

function labelFor(when: number, journal: JournalEntry[]): string {
  return journal.find((entry) => entry.when === when)?.tag ?? String(when);
}

/** 用镜像 journal 与库里已登记的 created_at 比较。不写死迁移编号或条数。 */
export function compareSchema(applied: AppliedMigration[] | null, journal: JournalEntry[]): CompareResult {
  const imageLatest = latestEntry(journal);
  if (!imageLatest) {
    if (!applied || applied.length === 0) return { status: 'missing' };
    const newest = applied.reduce((best, row) => (row.createdAt > best ? row.createdAt : best), applied[0]!.createdAt);
    return { status: 'ahead', dbLabel: String(newest), imageLabel: '镜像没有迁移' };
  }
  if (!applied || applied.length === 0) return { status: 'missing' };
  const dbNewest = applied.reduce((best, row) => (row.createdAt > best.createdAt ? row : best));
  const dbLabel = labelFor(dbNewest.createdAt, journal);
  const imageLabel = imageLatest.tag;
  if (dbNewest.createdAt < imageLatest.when) return { status: 'behind', dbLabel, imageLabel };
  if (dbNewest.createdAt > imageLatest.when) return { status: 'ahead', dbLabel, imageLabel };
  if (applied.length !== journal.length) {
    return { status: 'count-mismatch', appliedCount: applied.length, expectedCount: journal.length };
  }
  return { status: 'ok', latestTag: imageLatest.tag };
}

export function formatCompare(result: CompareResult): string {
  switch (result.status) {
    case 'ok':
      return `数据库结构与镜像一致（${result.latestTag}）`;
    case 'missing':
      return `数据库还没迁移：请先运行 ${SCHEMA_CMD}`;
    case 'behind':
      return `数据库结构落后于镜像（库 ${result.dbLabel}，镜像 ${result.imageLabel}）：请先运行 ${SCHEMA_CMD}`;
    case 'ahead':
      return '数据库比镜像新：回滚请先恢复备份再用旧镜像，见 release-runbook';
    case 'count-mismatch':
      return `数据库迁移条数与镜像不一致（库 ${result.appliedCount} 条，镜像 ${result.expectedCount} 条）：请先运行 ${SCHEMA_CMD}`;
  }
}

export function missingAdminUrlMessage(): string {
  return '[Flower schema] 缺少 DATABASE_ADMIN_URL';
}

function walk(error: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return out;
}

function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  for (const item of walk(error)) {
    if (item && typeof item === 'object' && 'code' in item && typeof item.code === 'string') codes.push(item.code);
  }
  return codes;
}

function textOf(error: unknown): string {
  return walk(error)
    .map((item) => (item instanceof Error ? item.message : ''))
    .filter(Boolean)
    .join('\n');
}

function waitedSeconds(startedAt: number, code: string, connectTimeoutSec: number): number {
  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (code === 'CONNECT_TIMEOUT') return Math.max(elapsed, connectTimeoutSec);
  return elapsed;
}

function waitedPhrase(seconds: number): string {
  return seconds <= 0 ? '等了不到 1 秒' : `等了 ${seconds} 秒`;
}

function isAuth(code: string, text: string): boolean {
  return code === '28P01' || code === '28000' || /password authentication failed/i.test(text) || /role .* does not exist/i.test(text);
}

/** 版本闸连库失败的一行中文说明。不带连接串、密码或堆栈。 */
export function formatGateDbError(error: unknown, target: DbTarget, startedAt: number, connectTimeoutSec: number): string {
  const codes = codesOf(error);
  const text = textOf(error);
  if (codes.includes('42501') || /permission denied/i.test(text)) {
    return `没有权限读取迁移登记表：请重跑 schema 补授权（${SCHEMA_CMD}）`;
  }
  if (codes.includes('42P01') || codes.includes('3F000')) {
    return `数据库还没迁移：请先运行 ${SCHEMA_CMD}`;
  }
  if (codes.some((code) => isAuth(code, text)) || isAuth('', text)) {
    return `数据库认证失败（账号 ${target.user}，主机 ${target.host}:${target.port}）。${MAYBE_SCHEMA}`;
  }
  const connectCode = codes.find((code) => CONNECT_CODES.has(code)) ?? '';
  const seconds = waitedSeconds(startedAt, connectCode, connectTimeoutSec);
  return `连不上数据库主机 ${target.host}:${target.port}（${waitedPhrase(seconds)}）。${MAYBE_SCHEMA}`;
}

/** schema 服务（迁移，不是 --check）的一行中文说明。 */
export function formatSchemaServiceFailure(error: unknown, adminUrl: string, startedAt = Date.now()): string {
  const target = dbTarget(adminUrl);
  const host = target?.host ?? '未知主机';
  const port = target?.port ?? '未知端口';
  const user = target?.user ?? '未知账号';
  const codes = codesOf(error);
  const text = textOf(error);
  if (!target) return '[Flower schema] 连不上数据库（连接串无法解析，没有主机名）';
  if (codes.some((code) => isAuth(code, text)) || isAuth('', text)) {
    return `[Flower schema] 数据库认证失败（账号 ${user}，主机 ${host}:${port}）`;
  }
  const connectCode = codes.find((code) => CONNECT_CODES.has(code));
  if (connectCode) {
    const seconds = waitedSeconds(startedAt, connectCode, CONNECT_TIMEOUT_SEC);
    return `[Flower schema] 连不上数据库主机 ${host}:${port}（${waitedPhrase(seconds)}）`;
  }
  return `[Flower schema] 迁移失败（主机 ${host}:${port}）`;
}

export async function checkSchema(
  databaseUrl: string,
  migrationsDir: string,
  opts: { connectTimeoutSec?: number; budgetMs?: number } = {},
): Promise<void> {
  const connectTimeoutSec = opts.connectTimeoutSec ?? CONNECT_TIMEOUT_SEC;
  const budgetMs = opts.budgetMs ?? CHECK_BUDGET_MS;
  const target = dbTarget(databaseUrl);
  if (!target) {
    throw new GateError(`连不上数据库（连接串无法解析，没有主机名）。${MAYBE_SCHEMA}`);
  }
  const started = Date.now();
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: connectTimeoutSec,
    onnotice: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('check budget'), { code: 'CHECK_BUDGET' }));
    }, budgetMs);
  });
  try {
    const rows = await Promise.race([
      client<{ created_at: string | number | null }[]>`select created_at from drizzle.__drizzle_migrations`,
      budget,
    ]);
    const applied = rows.map((row) => ({ createdAt: Number(row.created_at) }));
    const result = compareSchema(applied, readJournal(migrationsDir));
    if (result.status !== 'ok') throw new GateError(formatCompare(result));
    console.log(formatCompare(result));
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError(formatGateDbError(error, target, started, connectTimeoutSec));
  } finally {
    if (timer) clearTimeout(timer);
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
