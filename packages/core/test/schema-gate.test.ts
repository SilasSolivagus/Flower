import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
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
    expect(formatCompare(compareSchema([], journal))).toBe('数据库还没迁移。下一步：运行 docker compose --profile schema run --rm schema');
  });

  it('登记表不存在（applied 为 null）为 missing', () => {
    expect(compareSchema(null, journal).status).toBe('missing');
  });

  it('库的最新时间早于镜像为 behind，并带上两边标签', () => {
    const result = compareSchema(applied([10]), journal);
    expect(result).toEqual({ status: 'behind', dbLabel: 'm_old', imageLabel: 'm_new' });
    expect(formatCompare(result)).toBe('数据库结构落后于镜像（库 m_old，镜像 m_new）。下一步：运行 docker compose --profile schema run --rm schema');
  });

  it('库的最新时间晚于镜像为 ahead', () => {
    const result = compareSchema(applied([10, 20, 30]), journal);
    expect(result.status).toBe('ahead');
    expect(formatCompare(result)).toBe('数据库比镜像新，不能用这个旧镜像启动。下一步：先恢复备份再用旧镜像（见发布手册 docs/release-runbook.md「回滚」）');
  });

  it('最新时间相同但条数不同', () => {
    const result = compareSchema(applied([20]), journal);
    expect(result).toEqual({ status: 'count-mismatch', appliedCount: 1, expectedCount: 2 });
    expect(formatCompare(result)).toBe('数据库迁移条数与镜像不一致（库 1 条，镜像 2 条）。下一步：运行 docker compose --profile schema run --rm schema');
  });
});

describe('版本闸文案', () => {
  const target = { host: 'postgres', port: '5432', user: 'flower_app' };

  it('没有权限与缺表分开', () => {
    const denied = formatGateDbError({ code: '42501', message: 'permission denied for table __drizzle_migrations' }, target, Date.now(), 10);
    const absent = formatGateDbError({ code: '42P01', message: 'relation does not exist' }, target, Date.now(), 10);
    const schemaMissing = formatGateDbError({ code: '3F000', message: 'schema does not exist' }, target, Date.now(), 10);
    expect(denied).toBe('没有权限读取迁移登记表。下一步：重跑 schema 补授权（docker compose --profile schema run --rm schema）');
    expect(denied).not.toContain('还没迁移');
    expect(absent).toBe('数据库还没迁移。下一步：运行 docker compose --profile schema run --rm schema');
    expect(absent).not.toContain('没有权限');
    expect(schemaMissing).toBe('数据库还没迁移。下一步：运行 docker compose --profile schema run --rm schema');
    for (const line of [denied, absent, schemaMissing]) expect(line).not.toMatch(/\n\s+at /);
  });

  it('连不上库与认证失败分开，带主机和端口，并提示先跑 schema', () => {
    const future = Date.now() + 60_000;
    const refused = formatGateDbError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, target, future, 10);
    const timeout = formatGateDbError({ code: 'CONNECT_TIMEOUT', message: 'write CONNECT_TIMEOUT postgres:5432' }, target, Date.now(), 10);
    const auth = formatGateDbError({ code: '28P01', message: 'password authentication failed for user "flower_app"' }, target, Date.now(), 10);
    expect(refused).toBe('连不上数据库主机 postgres:5432（等了不到 1 秒）。下一步：确认 postgres 容器已启动、DATABASE_URL 主机端口正确；全新部署则可能还没迁移，先跑 docker compose --profile schema run --rm schema');
    expect(timeout).toBe('连不上数据库主机 postgres:5432（等了 10 秒）。下一步：确认 postgres 容器已启动、DATABASE_URL 主机端口正确；全新部署则可能还没迁移，先跑 docker compose --profile schema run --rm schema');
    expect(auth).toBe('数据库认证失败（账号 flower_app，主机 postgres:5432）。下一步：核对 .env 里该账号的密码（特殊字符要 URL 编码）；全新空库则可能还没迁移，先跑 docker compose --profile schema run --rm schema');
    for (const line of [refused, timeout, auth]) {
      expect(line).not.toMatch(/postgres:\/\//);
      expect(line).not.toMatch(/\n\s+at /);
    }
  });

  it('schema 服务缺连接串、连不上、认证失败各自一行', () => {
    const future = Date.now() + 60_000;
    expect(missingAdminUrlMessage()).toBe('[Flower schema] 缺少 DATABASE_ADMIN_URL。下一步：确认它已传进 schema 容器且不为空，再重跑 docker compose --profile schema run --rm schema');
    const down = formatSchemaServiceFailure({ code: 'ECONNREFUSED' }, 'postgres://flower_admin:secret@postgres:5432/flower', future);
    const auth = formatSchemaServiceFailure({ code: '28P01', message: 'password authentication failed' }, 'postgres://flower_admin:secret@postgres:5432/flower');
    const unparsed = formatSchemaServiceFailure(new Error('bad'), 'not a url');
    const failed = formatSchemaServiceFailure(new Error('syntax error'), 'postgres://flower_admin:secret@postgres:5432/flower');
    expect(down).toBe('[Flower schema] 连不上数据库主机 postgres:5432（等了不到 1 秒）。下一步：确认 postgres 容器已启动后重跑 docker compose --profile schema run --rm schema');
    expect(auth).toBe('[Flower schema] 数据库认证失败（账号 flower_admin，主机 postgres:5432）。下一步：核对 .env 里 DATABASE_ADMIN_URL 的账号密码（特殊字符要 URL 编码），再重跑 docker compose --profile schema run --rm schema');
    expect(unparsed).toBe('[Flower schema] 连不上数据库（连接串无法解析，没有主机名）。下一步：检查 DATABASE_ADMIN_URL 格式（postgres://账号:密码@主机:端口/库名）');
    expect(failed).toBe('[Flower schema] 迁移失败（主机 postgres:5432）。下一步：看上面 postgres 报错，修好后重跑 docker compose --profile schema run --rm schema；不要直接起 web');
    const wrapped = formatSchemaServiceFailure(
      { message: 'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"', cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' } },
      'postgres://flower_admin:secret@127.0.0.1:5432/flower',
      future,
    );
    expect(wrapped).toBe('[Flower schema] 连不上数据库主机 127.0.0.1:5432（等了不到 1 秒）。下一步：确认 postgres 容器已启动后重跑 docker compose --profile schema run --rm schema');
    for (const line of [down, auth, unparsed, failed, wrapped]) {
      expect(line).not.toContain('secret');
      expect(line).not.toMatch(/\n\s+at /);
    }
    expect(wrapped).not.toContain('Failed query');
    expect(unparsed).not.toContain('flower_admin');
  });

  it('不写死迁移编号或条数，连接超时不超过 10 秒，--check 不超过 30 秒', () => {
    const src = readFileSync(new URL('../src/db/schema-gate.ts', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../src/db/migrate-cli.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/00\d{2}_/);
    expect(cli).not.toMatch(/00\d{2}_/);
    expect(src).not.toMatch(/postgres:\/\/[A-Za-z0-9]/);
    expect(cli).not.toMatch(/postgres:\/\/[A-Za-z0-9]/);
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
      const previous = image.filter((entry) => entry.when !== latest.when).reduce((best, entry) => (entry.when > best.when ? entry : best));
      const behind = await checkSchema(appUrl, MIGRATIONS_DIR).then(
        () => null,
        (error: unknown) => error,
      );
      expect(behind).toBeInstanceOf(Error);
      expect((behind as Error).message).toBe(`数据库结构落后于镜像（库 ${previous.tag}，镜像 ${latest.tag}）。下一步：运行 docker compose --profile schema run --rm schema`);
      await admin`insert into drizzle.__drizzle_migrations (hash, created_at) values ('ahead', ${latest.when}), ('further', ${latest.when + 1})`;
      const ahead = await checkSchema(appUrl, MIGRATIONS_DIR).then(
        () => null,
        (error: unknown) => error,
      );
      expect(ahead).toBeInstanceOf(Error);
      expect((ahead as Error).message).toBe('数据库比镜像新，不能用这个旧镜像启动。下一步：先恢复备份再用旧镜像（见发布手册 docs/release-runbook.md「回滚」）');
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('空库缺表、错密码、收回授权，三条提示互不相同', async () => {
    const name = await freshDb();
    const appUrl = urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD });
    const missing = await checkSchema(appUrl, MIGRATIONS_DIR).then(
      () => null,
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toBe('数据库还没迁移。下一步：运行 docker compose --profile schema run --rm schema');

    const wrong = urlFor(ADMIN_URL, name, { name: 'flower_app', password: 'not-the-password' });
    const auth = await checkSchema(wrong, MIGRATIONS_DIR).then(
      () => null,
      (error: unknown) => error,
    );
    expect(auth).toBeInstanceOf(Error);
    expect((auth as Error).message).toBe('数据库认证失败（账号 flower_app，主机 localhost:54329）。下一步：核对 .env 里该账号的密码（特殊字符要 URL 编码）；全新空库则可能还没迁移，先跑 docker compose --profile schema run --rm schema');
    expect((auth as Error).message).not.toMatch(/\n\s+at /);
    expect((auth as Error).message).not.toContain('not-the-password');

    await runMigrations(urlFor(ADMIN_URL, name), APP_PASSWORD);
    const admin = postgres(urlFor(ADMIN_URL, name), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe('REVOKE SELECT ON drizzle.__drizzle_migrations FROM flower_app');
      const denied = await checkSchema(appUrl, MIGRATIONS_DIR).then(
        () => null,
        (error: unknown) => error,
      );
      expect(denied).toBeInstanceOf(Error);
      expect((denied as Error).message).toBe('没有权限读取迁移登记表。下一步：重跑 schema 补授权（docker compose --profile schema run --rm schema）');
      expect((denied as Error).message).not.toContain('还没迁移');
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

  it('--check 失败行带启动检查前缀', async () => {
    const name = await freshDb();
    const appUrl = urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'flower-cli-'));
    const outfile = path.join(dir, 'migrate.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../src/db/migrate-cli.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile,
      banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
    });
    try {
      let code = 0;
      let stderr = '';
      try {
        const result = await execFileAsync(process.execPath, [outfile, '--check'], {
          env: {
            ...process.env,
            DATABASE_URL: appUrl,
            FLOWER_SECRET_KEY: '0123456789abcdef0123456789abcdef',
          },
        });
        stderr = result.stderr;
      } catch (error) {
        const failed = error as { code?: number | string; stderr?: string };
        code = typeof failed.code === 'number' ? failed.code : 1;
        stderr = failed.stderr ?? '';
      }
      expect(code).toBe(1);
      expect(stderr.trim()).toBe('[Flower 启动检查] 数据库还没迁移。下一步：运行 docker compose --profile schema run --rm schema');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
