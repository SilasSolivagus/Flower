import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import {
  CHECK_BUDGET_MS,
  CONNECT_TIMEOUT_SEC,
  checkSchema,
  compareSchema,
  formatCompare,
  formatGateDbError,
  formatSchemaServiceFailure,
  missingAdminUrlMessage,
  readJournal,
  type JournalEntry,
} from '../src/db/schema-gate';
import { ADMIN_URL, APP_PASSWORD, urlFor } from './db';

const journal: JournalEntry[] = [
  { idx: 0, when: 10, tag: 'm_old' },
  { idx: 1, when: 20, tag: 'm_new' },
];

function applied(whens: number[]) {
  return whens.map((createdAt) => ({ createdAt }));
}

describe('compareSchema', () => {
  it('最新时间相同且条数相同为 ok', () => {
    expect(compareSchema(applied([10, 20]), journal)).toEqual({ status: 'ok', latestTag: 'm_new' });
  });

  it('空表为 missing', () => {
    expect(compareSchema([], journal).status).toBe('missing');
    expect(formatCompare(compareSchema([], journal))).toContain('还没迁移');
  });

  it('登记表不存在（applied 为 null）为 missing', () => {
    expect(compareSchema(null, journal).status).toBe('missing');
  });

  it('库的最新时间早于镜像为 behind，并带上两边标签', () => {
    const result = compareSchema(applied([10]), journal);
    expect(result).toEqual({ status: 'behind', dbLabel: 'm_old', imageLabel: 'm_new' });
    expect(formatCompare(result)).toContain('m_old');
    expect(formatCompare(result)).toContain('m_new');
  });

  it('库的最新时间晚于镜像为 ahead', () => {
    const result = compareSchema(applied([10, 20, 30]), journal);
    expect(result.status).toBe('ahead');
    expect(formatCompare(result)).toContain('先恢复备份再用旧镜像');
  });

  it('最新时间相同但条数不同', () => {
    const result = compareSchema(applied([20]), journal);
    expect(result).toEqual({ status: 'count-mismatch', appliedCount: 1, expectedCount: 2 });
    expect(formatCompare(result)).toContain('不一致');
  });
});

describe('版本闸文案', () => {
  const target = { host: 'postgres', port: '5432', user: 'flower_app' };

  it('没有权限与缺表分开', () => {
    const denied = formatGateDbError({ code: '42501', message: 'permission denied for table __drizzle_migrations' }, target, Date.now(), 10);
    const absent = formatGateDbError({ code: '42P01', message: 'relation does not exist' }, target, Date.now(), 10);
    const schemaMissing = formatGateDbError({ code: '3F000', message: 'schema does not exist' }, target, Date.now(), 10);
    expect(denied).toContain('没有权限');
    expect(denied).not.toContain('还没迁移');
    expect(denied).toContain('schema');
    expect(absent).toContain('还没迁移');
    expect(absent).not.toContain('没有权限');
    expect(schemaMissing).toContain('还没迁移');
  });

  it('连不上库与认证失败分开，带主机和端口，并提示先跑 schema', () => {
    const refused = formatGateDbError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, target, Date.now(), 10);
    const timeout = formatGateDbError({ code: 'CONNECT_TIMEOUT', message: 'write CONNECT_TIMEOUT postgres:5432' }, target, Date.now() - 10_000, 10);
    const auth = formatGateDbError({ code: '28P01', message: 'password authentication failed for user "flower_app"' }, target, Date.now(), 10);
    for (const line of [refused, timeout, auth]) {
      expect(line).toContain('postgres:5432');
      expect(line).toContain('schema');
      expect(line).not.toMatch(/postgres:\/\//);
      expect(line).not.toMatch(/\n\s+at /);
    }
    expect(refused).toContain('连不上');
    expect(timeout).toMatch(/等了 \d+ 秒/);
    expect(auth).toContain('认证失败');
    expect(auth).toContain('flower_app');
    expect(auth).toContain('可能还没迁移');
  });

  it('schema 服务缺连接串、连不上、认证失败各自一行', () => {
    expect(missingAdminUrlMessage()).toBe('[Flower schema] 缺少 DATABASE_ADMIN_URL');
    const down = formatSchemaServiceFailure({ code: 'ECONNREFUSED' }, 'postgres://flower_admin:secret@postgres:5432/flower', Date.now());
    const auth = formatSchemaServiceFailure({ code: '28P01', message: 'password authentication failed' }, 'postgres://flower_admin:secret@postgres:5432/flower');
    expect(down).toContain('[Flower schema]');
    expect(down).toContain('连不上');
    expect(down).toContain('postgres:5432');
    expect(down).not.toContain('secret');
    expect(auth).toContain('认证失败');
    expect(auth).toContain('flower_admin');
    expect(auth).not.toContain('secret');
    const wrapped = formatSchemaServiceFailure(
      { message: 'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"', cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' } },
      'postgres://flower_admin:secret@127.0.0.1:5432/flower',
    );
    expect(wrapped).toContain('连不上');
    expect(wrapped).toContain('127.0.0.1:5432');
    expect(wrapped).not.toContain('secret');
    expect(wrapped).not.toContain('Failed query');
  });

  it('不写死迁移编号或条数，连接超时不超过 10 秒，--check 不超过 30 秒', () => {
    const src = readFileSync(new URL('../src/db/schema-gate.ts', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../src/db/migrate-cli.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/00\d{2}_/);
    expect(cli).not.toMatch(/00\d{2}_/);
    expect(src).not.toMatch(/postgres:\/\//);
    expect(cli).not.toMatch(/postgres:\/\//);
    expect(CONNECT_TIMEOUT_SEC).toBeLessThanOrEqual(10);
    expect(CHECK_BUDGET_MS).toBeLessThanOrEqual(30_000);
    expect(CONNECT_TIMEOUT_SEC).toBeGreaterThan(0);
    expect(CHECK_BUDGET_MS).toBeGreaterThan(0);
  });

  it('授权写在迁移和改密码之后、同一个连接关闭之前', () => {
    const src = readFileSync(new URL('../src/db/migrate.ts', import.meta.url), 'utf8');
    const alter = src.indexOf('ALTER ROLE flower_app');
    const usage = src.indexOf('GRANT USAGE ON SCHEMA drizzle TO flower_app');
    const select = src.indexOf('GRANT SELECT ON drizzle.__drizzle_migrations TO flower_app');
    const end = src.indexOf('client.end()');
    expect(alter).toBeGreaterThan(0);
    expect(usage).toBeGreaterThan(alter);
    expect(select).toBeGreaterThan(usage);
    expect(end).toBeGreaterThan(select);
  });
});

describe('checkSchema 集成', () => {
  const names: string[] = [];

  async function adminExec(statement: string): Promise<void> {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(statement);
    } finally {
      await admin.end();
    }
  }

  async function freshDb(): Promise<string> {
    const name = `flower_gate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await adminExec(`CREATE DATABASE ${name}`);
    names.push(name);
    return name;
  }

  afterAll(async () => {
    for (const name of names) await adminExec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });

  it('迁移之后 flower_app 能读登记表、写不进，且 created_at 等于 journal.when', async () => {
    const name = await freshDb();
    await runMigrations(urlFor(ADMIN_URL, name), APP_PASSWORD);
    const appUrl = urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await checkSchema(appUrl, MIGRATIONS_DIR);
      const image = readJournal(MIGRATIONS_DIR);
      const latest = image.reduce((best, entry) => (entry.when > best.when ? entry : best));
      expect(log).toHaveBeenCalledWith(`数据库结构与镜像一致（${latest.tag}）`);
    } finally {
      log.mockRestore();
    }
    const image = readJournal(MIGRATIONS_DIR);

    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const rows = await app<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations`;
      expect(rows.map((row) => Number(row.created_at)).sort((a, b) => a - b)).toEqual(image.map((entry) => entry.when).sort((a, b) => a - b));
      const count = await app`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(count[0]!.n).toBe(image.length);
      await expect(app`insert into drizzle.__drizzle_migrations (hash, created_at) values ('x', 1)`).rejects.toThrow(/permission denied/i);
      await expect(app`update drizzle.__drizzle_migrations set hash = 'y'`).rejects.toThrow(/permission denied/i);
      await expect(app`delete from drizzle.__drizzle_migrations`).rejects.toThrow(/permission denied/i);
      await expect(app`truncate drizzle.__drizzle_migrations`).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end();
    }
  }, 60_000);

  it('删掉最新一行后判定落后，插一条更大的时间后判定领先', async () => {
    const name = await freshDb();
    await runMigrations(urlFor(ADMIN_URL, name), APP_PASSWORD);
    const appUrl = urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD });
    const image = readJournal(MIGRATIONS_DIR);
    const latest = image.reduce((best, entry) => (entry.when > best.when ? entry : best));
    const admin = postgres(urlFor(ADMIN_URL, name), { max: 1, onnotice: () => {} });
    try {
      await admin`delete from drizzle.__drizzle_migrations where created_at = ${latest.when}`;
      await expect(checkSchema(appUrl, MIGRATIONS_DIR)).rejects.toThrow(new RegExp(latest.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      const previous = image.filter((entry) => entry.when !== latest.when).reduce((best, entry) => (entry.when > best.when ? entry : best));
      await expect(checkSchema(appUrl, MIGRATIONS_DIR)).rejects.toThrow(previous.tag);
      await admin`insert into drizzle.__drizzle_migrations (hash, created_at) values ('ahead', ${latest.when}), ('further', ${latest.when + 1})`;
      await expect(checkSchema(appUrl, MIGRATIONS_DIR)).rejects.toThrow('先恢复备份再用旧镜像');
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('空库缺表、错密码、收回授权，三条提示互不相同', async () => {
    const name = await freshDb();
    const appUrl = urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD });
    await expect(checkSchema(appUrl, MIGRATIONS_DIR)).rejects.toThrow('还没迁移');

    const wrong = urlFor(ADMIN_URL, name, { name: 'flower_app', password: 'not-the-password' });
    await expect(checkSchema(wrong, MIGRATIONS_DIR)).rejects.toThrow(/认证失败[\s\S]*schema/);
    await expect(checkSchema(wrong, MIGRATIONS_DIR)).rejects.not.toThrow(/\n\s+at /);

    await runMigrations(urlFor(ADMIN_URL, name), APP_PASSWORD);
    const admin = postgres(urlFor(ADMIN_URL, name), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe('REVOKE SELECT ON drizzle.__drizzle_migrations FROM flower_app');
      const denied = checkSchema(appUrl, MIGRATIONS_DIR);
      await expect(denied).rejects.toThrow('没有权限');
      await expect(checkSchema(appUrl, MIGRATIONS_DIR)).rejects.not.toThrow('还没迁移');
    } finally {
      await admin.end();
    }
    await runMigrations(urlFor(ADMIN_URL, name), APP_PASSWORD);
    await expect(checkSchema(appUrl, MIGRATIONS_DIR)).resolves.toBeUndefined();
  }, 60_000);

  it('用新密码能连上 flower_app', async () => {
    const name = await freshDb();
    await runMigrations(urlFor(ADMIN_URL, name), APP_PASSWORD);
    const app = postgres(urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD }), { max: 1, connect_timeout: 5 });
    try {
      const rows = await app`select 1 as ok`;
      expect(rows[0]!.ok).toBe(1);
    } finally {
      await app.end();
    }
    const bad = postgres(urlFor(ADMIN_URL, name, { name: 'flower_app', password: 'wrong-password' }), { max: 1, connect_timeout: 5 });
    try {
      await expect(bad`select 1`).rejects.toThrow();
    } finally {
      await bad.end();
    }
  }, 60_000);

  it('主机拒绝连接时很快失败，预算到点也不会一直重连', async () => {
    const started = Date.now();
    await expect(
      checkSchema('postgres://flower_app:secret@127.0.0.1:1/flower', MIGRATIONS_DIR, { connectTimeoutSec: 2, budgetMs: 5_000 }),
    ).rejects.toThrow(/连不上数据库主机 127\.0\.0\.1:1/);
    expect(Date.now() - started).toBeLessThan(5_000);

    const slow = Date.now();
    await expect(
      checkSchema('postgres://flower_app:secret@192.0.2.1:5432/flower', MIGRATIONS_DIR, { connectTimeoutSec: 30, budgetMs: 800 }),
    ).rejects.toThrow(/连不上数据库主机 192\.0\.2\.1:5432/);
    expect(Date.now() - slow).toBeLessThan(4_000);

    await expect(checkSchema('not a url', MIGRATIONS_DIR, { budgetMs: 500 })).rejects.toThrow('没有主机名');
  }, 20_000);
});
