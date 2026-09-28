# Flower P0-A 后端基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Flower 的 monorepo、数据库（含行级安全）、租户与身份、可配置定义、领域事件、REST API 与 docker 镜像，使 P0-B 的管理界面可以直接在其上开发。

**Architecture:** `packages/core` 是纯 TypeScript 领域层：drizzle schema、迁移、事务助手（`withOrg` / `withSystem`）与各服务函数；所有服务函数签名为 `(db, actor, input)`，内部开启事务、设置租户上下文、写领域事件。`apps/web` 是 Next.js 16 应用，在 `app/api/v1/[[...route]]` 挂载一个 Hono 应用作为唯一 API 入口；P0-B 在同一应用里加页面。运行时数据库角色 `flower_app` 不是表的所有者，受 RLS 约束；迁移用超级用户 `flower_admin` 执行。

**Tech Stack:** pnpm workspace、Node 22、TypeScript、PostgreSQL 17（`pgvector/pgvector:pg17`）、drizzle-orm + drizzle-kit、postgres-js、zod 4、@node-rs/argon2、uuidv7、Hono、Next.js 16、Vitest、esbuild、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§1 总体约定、§2 租户与身份、§3 可配置定义、§6.1 领域事件、§8 分阶段）

## Global Constraints

- 数据库镜像 `pgvector/pgvector:pg17`；ORM 为 drizzle。
- 主键一律 UUIDv7（`uuidv7` 包生成，应用侧 `$defaultFn`）。
- 所有租户数据表带 `org_id`；应用层用 `withOrg` 设置 `app.org_id`，RLS 策略再校验一次。跨组织查询只能在 `withSystem` 中进行，且只限本计划列出的函数。
- 缺少 `DATABASE_URL`、`DATABASE_ADMIN_URL`、`FLOWER_APP_DB_PASSWORD`、`FLOWER_SECRET_KEY` 任一环境变量时拒绝启动；不使用任何默认密钥。
- 只依赖 Postgres，不引入 Redis。
- API 路径前缀 `/api/v1`，组织资源在 `/api/v1/orgs/{org}/...` 下。
- 密码用 argon2id；会话与 API Token 只存 sha256 哈希，Token 明文只在创建时返回一次。
- 每个写操作在同一事务内写一条 `domain_events`。
- 时间字段一律 `timestamptz`。
- 面向用户的错误信息用中文。
- 每个 commit message 末尾加一行：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## 与 spec 的范围差异（有意为之）

- `packages/mcp` 在 P4 创建，本计划不建空包。
- `product_counters`、`entity_aliases` 随需求模块在 P1 建表；`event_deliveries` 随第一个事件消费者在 P3 建表。
- 敏感配置加密工具随第一个需要加密的配置（P3 通知通道）实现；本计划只校验 `FLOWER_SECRET_KEY` 存在且足够长。
- 流程版本升级时的状态映射（spec §3.1）需要需求数据才有意义，随需求表在 P1 实现；P0 中产品可直接切换流程版本。
- 实例设置中的 HTTP 取数白名单（spec §2.4）随通知中心在 P3 实现。
- 界面（初始化向导、登录、各设置页）在 P0-B 计划中实现。

## 文件结构

```
Flower/
├── package.json                    # workspace 根，脚本 db:up / test / typecheck / dev
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.dev.yml          # 开发与测试用 Postgres（端口 54329）
├── docker-compose.yml              # 自托管部署：postgres + flower
├── Dockerfile
├── docker/entrypoint.sh            # 先迁移，再启动 Next
├── scripts/smoke.sh                # 镜像冒烟测试
├── .env.example
├── CLAUDE.md                       # 项目命令
├── packages/core/
│   ├── package.json / tsconfig.json / vitest.config.ts / drizzle.config.ts
│   ├── migrations/                 # 0000_roles.sql、0001_init.sql、0002_rls.sql + meta/
│   ├── src/
│   │   ├── index.ts                # 对外导出
│   │   ├── config.ts               # 环境变量校验
│   │   ├── ids.ts                  # newId()
│   │   ├── crypto.ts               # randomToken / sha256 / safeEqualHex
│   │   ├── errors.ts               # AppError、isUniqueViolation
│   │   ├── domain-types.ts         # OrgRole / ProductRole / TokenScope / Actor
│   │   ├── db/schema.ts            # P0 全部表
│   │   ├── db/client.ts            # createDb
│   │   ├── db/tx.ts                # withOrg / withSystem
│   │   ├── db/migrate.ts           # runMigrations
│   │   ├── db/migrate-cli.ts       # 镜像内执行的迁移入口
│   │   ├── events.ts               # recordEvent
│   │   ├── auth/password.ts / accounts.ts / sessions.ts
│   │   ├── access/permissions.ts / tokens.ts
│   │   ├── tenancy/orgs.ts / products.ts / members.ts / function-tags.ts / invitations.ts
│   │   ├── definitions/workflow-schema.ts / defaults.ts / workflows.ts / fields.ts / levels.ts
│   │   └── setup/instance.ts
│   └── test/
│       ├── db.ts                   # createTestDb（从模板库克隆）
│       ├── global-setup.ts         # 建模板库并迁移
│       ├── factories.ts            # seedInstance / actorFor
│       └── *.test.ts
└── apps/web/
    ├── next.config.ts / vitest.config.ts / package.json
    ├── src/instrumentation.ts      # 启动时校验配置
    ├── src/app/api/v1/[[...route]]/route.ts
    ├── src/server/
    │   ├── runtime.ts              # 单例 db + api
    │   ├── api.ts                  # createApi
    │   ├── http.ts                 # 错误映射、readJson、cookie
    │   ├── auth-middleware.ts
    │   └── routes/*.ts
    └── test/api/*.test.ts
```

---

### Task 1: Workspace 骨架与基础工具

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.dev.yml`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`
- Create: `packages/core/src/config.ts`, `src/ids.ts`, `src/crypto.ts`, `src/errors.ts`, `src/domain-types.ts`, `src/index.ts`
- Test: `packages/core/test/config.test.ts`, `packages/core/test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env?: Record<string, string | undefined>): FlowerConfig`，`FlowerConfig = { databaseUrl; databaseAdminUrl; appDbPassword; secretKey; publicUrl; isProduction }`，`class ConfigError extends Error`
  - `newId(): string`
  - `randomToken(bytes?: number): string`（base64url），`sha256(input: string): string`（hex），`safeEqualHex(a: string, b: string): boolean`
  - `class AppError extends Error { code: ErrorCode; details?: unknown }`，`ErrorCode = 'invalid' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'already_initialized'`，`isUniqueViolation(e: unknown): boolean`
  - 类型 `OrgRole`、`ProductRole`、`TokenScope`、`Actor`

- [ ] **Step 1: 建立 workspace 根文件**

`package.json`：

```json
{
  "name": "flower",
  "private": true,
  "packageManager": "pnpm@10.33.2",
  "engines": { "node": ">=22" },
  "scripts": {
    "db:up": "docker compose -f docker-compose.dev.yml up -d --wait",
    "db:down": "docker compose -f docker-compose.dev.yml down",
    "test": "pnpm -r --workspace-concurrency=1 test",
    "typecheck": "pnpm -r typecheck",
    "dev": "pnpm --filter @flower/web dev"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*
onlyBuiltDependencies:
  - esbuild
  - sharp
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

`.gitignore`：

```
node_modules/
.next/
dist/
.env
.env.local
*.tsbuildinfo
```

`.env.example`：

```
# 本地开发（配合 docker-compose.dev.yml）
DATABASE_URL=postgres://flower_app:flower_app_dev@localhost:54329/flower
DATABASE_ADMIN_URL=postgres://flower_admin:flower_admin@localhost:54329/flower
FLOWER_APP_DB_PASSWORD=flower_app_dev
# 用 openssl rand -base64 48 生成
FLOWER_SECRET_KEY=
FLOWER_PUBLIC_URL=http://localhost:3000
```

`docker-compose.dev.yml`：

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: flower_admin
      POSTGRES_PASSWORD: flower_admin
      POSTGRES_DB: flower
    ports:
      - "54329:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U flower_admin -d flower"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes:
      - flower_dev_pg:/var/lib/postgresql/data
volumes:
  flower_dev_pg: {}
```

- [ ] **Step 2: 建立 core 包**

`packages/core/package.json`：

```json
{
  "name": "@flower/core",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./test/db.ts",
    "./testing/factories": "./test/factories.ts",
    "./testing/global-setup": "./test/global-setup.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "build:migrate": "esbuild src/db/migrate-cli.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/migrate.mjs --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\""
  }
}
```

安装依赖（版本由 pnpm 解析为当前最新）：

```bash
pnpm --filter @flower/core add drizzle-orm postgres zod uuidv7 @node-rs/argon2
pnpm --filter @flower/core add -D drizzle-kit esbuild typescript vitest @types/node
```

`packages/core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "drizzle.config.ts", "vitest.config.ts"]
}
```

`packages/core/vitest.config.ts`（Task 2 才加 globalSetup，本任务先保持最简）：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 60_000 },
});
```

- [ ] **Step 3: 写失败的测试**

`packages/core/test/config.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const full = {
  DATABASE_URL: 'postgres://a',
  DATABASE_ADMIN_URL: 'postgres://b',
  FLOWER_APP_DB_PASSWORD: 'pw',
  FLOWER_SECRET_KEY: 'x'.repeat(48),
};

describe('loadConfig', () => {
  it('缺少变量时列出全部缺失项', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*FLOWER_SECRET_KEY/);
  });

  it('密钥过短时拒绝', () => {
    expect(() => loadConfig({ ...full, FLOWER_SECRET_KEY: 'short' })).toThrow(/至少 32 个字符/);
  });

  it('变量齐全时返回配置', () => {
    const c = loadConfig({ ...full, NODE_ENV: 'production' });
    expect(c.databaseUrl).toBe('postgres://a');
    expect(c.publicUrl).toBe('http://localhost:3000');
    expect(c.isProduction).toBe(true);
  });
});
```

`packages/core/test/crypto.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { randomToken, safeEqualHex, sha256 } from '../src/crypto';
import { newId } from '../src/ids';

describe('crypto', () => {
  it('randomToken 默认 32 字节，base64url 编码为 43 个字符', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it('sha256 输出 64 位十六进制', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('safeEqualHex 比较相等与不等', () => {
    expect(safeEqualHex(sha256('a'), sha256('a'))).toBe(true);
    expect(safeEqualHex(sha256('a'), sha256('b'))).toBe(false);
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
  });

  it('newId 生成按时间递增的 UUIDv7', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm install && pnpm --filter @flower/core test`
Expected: FAIL，提示无法解析 `../src/config`、`../src/crypto`。

- [ ] **Step 5: 实现**

`packages/core/src/config.ts`：

```ts
export type FlowerConfig = {
  databaseUrl: string;
  databaseAdminUrl: string;
  appDbPassword: string;
  secretKey: string;
  publicUrl: string;
  isProduction: boolean;
};

export class ConfigError extends Error {}

const REQUIRED = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'FLOWER_APP_DB_PASSWORD', 'FLOWER_SECRET_KEY'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): FlowerConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new ConfigError(
      `缺少环境变量：${missing.join(', ')}。FLOWER_SECRET_KEY 可用 openssl rand -base64 48 生成。`,
    );
  }
  const secretKey = env.FLOWER_SECRET_KEY as string;
  if (secretKey.length < 32) {
    throw new ConfigError('FLOWER_SECRET_KEY 至少 32 个字符，可用 openssl rand -base64 48 生成。');
  }
  return {
    databaseUrl: env.DATABASE_URL as string,
    databaseAdminUrl: env.DATABASE_ADMIN_URL as string,
    appDbPassword: env.FLOWER_APP_DB_PASSWORD as string,
    secretKey,
    publicUrl: env.FLOWER_PUBLIC_URL ?? 'http://localhost:3000',
    isProduction: env.NODE_ENV === 'production',
  };
}
```

`packages/core/src/ids.ts`：

```ts
import { uuidv7 } from 'uuidv7';

export const newId = (): string => uuidv7();
```

`packages/core/src/crypto.ts`：

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
```

`packages/core/src/errors.ts`：

```ts
export type ErrorCode =
  | 'invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'already_initialized';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** drizzle 会把驱动错误包在 cause 里，逐层查找 Postgres 错误码。 */
export function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export const isUniqueViolation = (e: unknown): boolean => pgErrorCode(e) === '23505';
```

`packages/core/src/domain-types.ts`：

```ts
export const ORG_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PRODUCT_ROLES = ['admin', 'editor', 'viewer'] as const;
export type ProductRole = (typeof PRODUCT_ROLES)[number];

export type TokenScope = { products: 'all' | string[]; access: 'read' | 'write' };

/** 一次请求的操作者：会话用户或 API Token 背后的成员。 */
export type Actor = {
  accountId: string | null;
  memberId: string;
  orgId: string;
  orgRole: OrgRole;
  tokenId: string | null;
  tokenScope: TokenScope | null;
};
```

`packages/core/src/index.ts`（本任务只导出已有模块，后续任务逐步追加）：

```ts
export * from './config';
export * from './ids';
export * from './crypto';
export * from './errors';
export * from './domain-types';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core test && pnpm --filter @flower/core typecheck`
Expected: PASS（2 个测试文件，7 个用例），typecheck 无错误。

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore .env.example docker-compose.dev.yml packages/core
git commit -m "feat(core): workspace 骨架、配置校验与基础工具"
```

---

### Task 2: 数据库 schema、迁移、事务助手与行级安全

**Files:**
- Create: `packages/core/drizzle.config.ts`
- Create: `packages/core/src/db/schema.ts`, `src/db/client.ts`, `src/db/tx.ts`, `src/db/migrate.ts`, `src/db/migrate-cli.ts`
- Create: `packages/core/migrations/0000_roles.sql`, `0001_init.sql`（生成）, `0002_rls.sql`, `meta/*`（生成）
- Create: `packages/core/test/db.ts`, `test/global-setup.ts`
- Modify: `packages/core/vitest.config.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/rls.test.ts`

**Interfaces:**
- Consumes: `newId`（Task 1）、`TokenScope`、`OrgRole`、`ProductRole`
- Produces:
  - drizzle 表：`instanceSettings, accounts, sessions, organizations, products, members, productMembers, functionTags, memberFunctionTags, invitations, apiTokens, workflowDefinitions, workflowVersions, fieldDefinitions, fieldOptions, domainEvents`
  - `type Db`、`createDb(url: string, opts?: { max?: number }): { db: Db; close(): Promise<void> }`
  - `type Tx`、`type Queryable = Db | Tx`、`withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>`、`withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>`、`setOrgContext(tx: Tx, orgId: string): Promise<void>`
  - `runMigrations(adminUrl: string, appDbPassword: string, migrationsFolder?: string): Promise<void>`
  - 测试工具：`createTestDb(): Promise<{ db: Db; adminDb: Db; cleanup(): Promise<void> }>`

- [ ] **Step 1: 写 schema**

`packages/core/src/db/schema.ts`：

```ts
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { TokenScope } from '../domain-types';
import { newId } from '../ids';

const id = () => uuid('id').primaryKey().$defaultFn(newId);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const orgRef = () => uuid('org_id').notNull().references(() => organizations.id);

export type AccountPreferences = { theme?: 'light' | 'dark' | 'system'; locale?: string; timezone?: string };
export type OrgSettings = { timezone?: string; structureLevelNames?: string[] };

// ---------- 全局表（无 RLS） ----------

export const instanceSettings = pgTable(
  'instance_settings',
  {
    id: smallint('id').primaryKey().default(1),
    initializedAt: ts('initialized_at'),
    allowSignup: boolean('allow_signup').notNull().default(false),
    allowOrgCreation: boolean('allow_org_creation').notNull().default(false),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('instance_settings_singleton', sql`${t.id} = 1`)],
);

export const accounts = pgTable('accounts', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
  preferences: jsonb('preferences').$type<AccountPreferences>().notNull().default({}),
  createdAt: createdAt(),
  lastLoginAt: ts('last_login_at'),
});

export const sessions = pgTable('sessions', {
  id: id(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
});

// ---------- 租户表（RLS，见 0002_rls.sql） ----------

export const organizations = pgTable('organizations', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<OrgSettings>().notNull().default({}),
  createdAt: createdAt(),
  deletedAt: ts('deleted_at'),
});

export const products = pgTable(
  'products',
  {
    id: id(),
    orgId: orgRef(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    workflowVersionId: uuid('workflow_version_id').references((): AnyPgColumn => workflowVersions.id),
    structureLevelNames: jsonb('structure_level_names').$type<string[]>(),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [uniqueIndex('products_org_key').on(t.orgId, t.key)],
);

export const members = pgTable(
  'members',
  {
    id: id(),
    orgId: orgRef(),
    accountId: uuid('account_id').references(() => accounts.id),
    kind: text('kind', { enum: ['human', 'agent'] }).notNull().default('human'),
    displayName: text('display_name').notNull(),
    email: text('email'),
    department: text('department'),
    orgRole: text('org_role', { enum: ['owner', 'admin', 'member', 'guest'] }).notNull(),
    status: text('status', { enum: ['active', 'left'] }).notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('members_org_account').on(t.orgId, t.accountId), index('members_account').on(t.accountId)],
);

export const productMembers = pgTable(
  'product_members',
  {
    orgId: orgRef(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    role: text('role', { enum: ['admin', 'editor', 'viewer'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.memberId] })],
);

export const functionTags = pgTable(
  'function_tags',
  {
    id: id(),
    orgId: orgRef(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('function_tags_org_name').on(t.orgId, t.name)],
);

export const memberFunctionTags = pgTable(
  'member_function_tags',
  {
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => functionTags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.tagId] })],
);

export const invitations = pgTable('invitations', {
  id: id(),
  orgId: orgRef(),
  email: text('email').notNull(),
  memberId: uuid('member_id').references(() => members.id),
  orgRole: text('org_role', { enum: ['admin', 'member', 'guest'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => members.id),
  acceptedAt: ts('accepted_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  orgId: orgRef(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id),
  issuedBy: uuid('issued_by')
    .notNull()
    .references(() => members.id),
  name: text('name').notNull(),
  prefix: text('prefix').notNull().unique(),
  tokenHash: text('token_hash').notNull(),
  scope: jsonb('scope').$type<TokenScope>().notNull(),
  expiresAt: ts('expires_at'),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

export const workflowDefinitions = pgTable('workflow_definitions', {
  id: id(),
  orgId: orgRef(),
  productId: uuid('product_id').references((): AnyPgColumn => products.id),
  name: text('name').notNull(),
  forkedFromVersionId: uuid('forked_from_version_id').references((): AnyPgColumn => workflowVersions.id),
  currentVersionId: uuid('current_version_id').references((): AnyPgColumn => workflowVersions.id),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
});

export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: id(),
    orgId: orgRef(),
    definitionId: uuid('definition_id')
      .notNull()
      .references((): AnyPgColumn => workflowDefinitions.id),
    version: integer('version').notNull(),
    body: jsonb('body').$type<unknown>().notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('workflow_versions_def_version').on(t.definitionId, t.version)],
);

export const fieldDefinitions = pgTable(
  'field_definitions',
  {
    id: id(),
    orgId: orgRef(),
    productId: uuid('product_id').references(() => products.id),
    key: text('key').notNull(),
    label: text('label').notNull(),
    cardinality: text('cardinality', { enum: ['single', 'multi'] }).notNull(),
    builtin: boolean('builtin').notNull().default(false),
    appliesTo: text('applies_to').notNull().default('requirement'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('field_definitions_org_key').on(t.orgId, t.key).where(sql`${t.productId} is null`),
    uniqueIndex('field_definitions_product_key').on(t.productId, t.key).where(sql`${t.productId} is not null`),
  ],
);

export const fieldOptions = pgTable(
  'field_options',
  {
    id: id(),
    orgId: orgRef(),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fieldDefinitions.id),
    key: text('key').notNull(),
    label: text('label').notNull(),
    color: text('color'),
    sort: integer('sort').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('field_options_field_key').on(t.fieldId, t.key)],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    id: id(),
    orgId: orgRef(),
    productId: uuid('product_id'),
    type: text('type').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    actorMemberId: uuid('actor_member_id'),
    actorTokenId: uuid('actor_token_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('domain_events_org_time').on(t.orgId, t.occurredAt.desc())],
);
```

- [ ] **Step 2: 写 drizzle 配置并生成迁移**

`packages/core/drizzle.config.ts`：

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
});
```

依次执行（顺序决定迁移编号：角色必须先于建表，RLS 必须在建表之后）：

```bash
cd packages/core
pnpm drizzle-kit generate --custom --name=roles
pnpm drizzle-kit generate --name=init
pnpm drizzle-kit generate --custom --name=rls
cd ../..
```

Expected: `migrations/` 下出现 `0000_roles.sql`（空）、`0001_init.sql`（全部建表语句）、`0002_rls.sql`（空）和 `meta/_journal.json`。

把 `migrations/0000_roles.sql` 的内容改为：

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flower_app') THEN
    CREATE ROLE flower_app LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO flower_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flower_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flower_app;
```

把 `migrations/0002_rls.sql` 的内容改为：

```sql
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'products', 'members', 'product_members', 'function_tags', 'member_function_tags',
    'invitations', 'api_tokens', 'workflow_definitions', 'workflow_versions',
    'field_definitions', 'field_options', 'domain_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I
        USING (current_setting('app.scope', true) = 'system'
               OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (current_setting('app.scope', true) = 'system'
               OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$,
      t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organizations
  USING (current_setting('app.scope', true) = 'system'
         OR id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system'
         OR id = nullif(current_setting('app.org_id', true), '')::uuid);
```

说明：连接池复用连接时，事务级 `set_config` 结束后变量会变成空字符串而不是 NULL，所以必须用 `nullif(..., '')` 再转 uuid，否则会报类型转换错误。

- [ ] **Step 3: 写数据库客户端、事务助手、迁移函数**

`packages/core/src/db/client.ts`：

```ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string, opts: { max?: number } = {}): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}
```

`packages/core/src/db/tx.ts`：

```ts
import { sql } from 'drizzle-orm';
import type { Db } from './client';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Queryable = Db | Tx;

export async function setOrgContext(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
}

/** 在某个组织的上下文中执行：RLS 只放行该组织的数据。 */
export function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return fn(tx);
  });
}

/** 跨组织查询，只允许用于登录、成员关系查找、Token 校验、邀请接受等少数场景。 */
export function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.scope', 'system', true)`);
    return fn(tx);
  });
}
```

`packages/core/src/db/migrate.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export function quoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** 以超级用户执行迁移，然后为运行时角色 flower_app 设置密码。 */
export async function runMigrations(
  adminUrl: string,
  appDbPassword: string,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    await client.unsafe(`ALTER ROLE flower_app WITH LOGIN PASSWORD ${quoteLiteral(appDbPassword)}`);
  } finally {
    await client.end();
  }
}
```

`packages/core/src/db/migrate-cli.ts`：

```ts
import { loadConfig } from '../config';
import { runMigrations } from './migrate';

const config = loadConfig();
await runMigrations(config.databaseAdminUrl, config.appDbPassword, process.env.FLOWER_MIGRATIONS_DIR ?? 'migrations');
console.log('数据库迁移完成');
```

在 `packages/core/src/index.ts` 追加：

```ts
export * from './db/schema';
export * from './db/client';
export * from './db/tx';
export { runMigrations } from './db/migrate';
```

- [ ] **Step 4: 写测试基础设施**

`packages/core/test/db.ts`：

```ts
import postgres from 'postgres';
import { createDb, type Db } from '../src/db/client';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://flower_admin:flower_admin@localhost:54329/postgres';
export const TEMPLATE_DB = 'flower_test_template';
export const APP_PASSWORD = 'flower_app_test';

export function urlFor(base: string, dbName: string, user?: { name: string; password: string }): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

async function adminExec(statement: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

/** 从已迁移的模板库克隆出一个独立数据库；db 以 flower_app 身份连接（受 RLS 约束），adminDb 以超级用户连接。 */
export async function createTestDb(): Promise<{ db: Db; adminDb: Db; cleanup: () => Promise<void> }> {
  const name = `flower_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await adminExec(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  const app = createDb(urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD }), { max: 4 });
  const admin = createDb(urlFor(ADMIN_URL, name), { max: 2 });
  return {
    db: app.db,
    adminDb: admin.db,
    async cleanup() {
      await app.close();
      await admin.close();
      await adminExec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}
```

`packages/core/test/global-setup.ts`：

```ts
import postgres from 'postgres';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_URL, APP_PASSWORD, TEMPLATE_DB, urlFor } from './db';

async function exec(statement: string) {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

export default async function setup() {
  await exec(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await exec(`CREATE DATABASE ${TEMPLATE_DB}`);
  await runMigrations(urlFor(ADMIN_URL, TEMPLATE_DB), APP_PASSWORD);
  return async () => {
    await exec(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  };
}
```

`packages/core/vitest.config.ts` 改为：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **Step 5: 写失败的 RLS 测试**

`packages/core/test/rls.test.ts`：

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, products } from '../src/db/schema';
import { withOrg, withSystem } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values([
    { orgId: orgA, key: 'AA', name: 'A 产品' },
    { orgId: orgB, key: 'BB', name: 'B 产品' },
  ]);
});
afterAll(() => t.cleanup());

describe('行级安全', () => {
  it('运行时角色不是超级用户', async () => {
    const rows = await t.db.execute(sql`select rolsuper from pg_roles where rolname = current_user`);
    expect(rows[0]).toMatchObject({ rolsuper: false });
  });

  it('未设置组织上下文时看不到任何租户数据', async () => {
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(await t.db.select().from(organizations)).toHaveLength(0);
  });

  it('withOrg 只能看到本组织的数据', async () => {
    const rows = await withOrg(t.db, orgA, (tx) => tx.select().from(products));
    expect(rows.map((r) => r.key)).toEqual(['AA']);
    const orgs = await withOrg(t.db, orgA, (tx) => tx.select().from(organizations));
    expect(orgs.map((o) => o.slug)).toEqual(['a']);
  });

  it('withOrg 不能写入其他组织的数据', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) => tx.insert(products).values({ orgId: orgB, key: 'XX', name: '越权' })),
    ).rejects.toThrow();
  });

  it('withOrg 不能改到其他组织的数据', async () => {
    const updated = await withOrg(t.db, orgA, (tx) =>
      tx.update(products).set({ name: '被改了' }).where(eq(products.key, 'BB')).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('上下文不会泄漏到同一连接的下一个事务', async () => {
    await withOrg(t.db, orgA, (tx) => tx.select().from(products));
    expect(await t.db.select().from(products)).toHaveLength(0);
  });

  it('withSystem 可以跨组织读取', async () => {
    const rows = await withSystem(t.db, (tx) => tx.select().from(products));
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 6: 运行测试确认结果**

Run: `pnpm db:up && pnpm --filter @flower/core test`
Expected: PASS（`rls.test.ts` 7 个用例全部通过）。如果"运行时角色不是超级用户"或"未设置组织上下文"失败，检查 `0000_roles.sql` 是否排在 `0001_init.sql` 之前（默认权限必须先于建表设置）。

- [ ] **Step 7: 提交**

```bash
git add packages/core
git commit -m "feat(core): 数据库 schema、迁移与行级安全"
```

---

### Task 3: 领域事件

**Files:**
- Create: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/events.test.ts`

**Interfaces:**
- Consumes: `Tx`、`domainEvents`、`Actor`
- Produces: `type EventInput = { orgId: string; productId?: string | null; type: string; subjectType: string; subjectId: string; actor: Actor | null; payload?: Record<string, unknown> }`，`recordEvent(tx: Tx, e: EventInput): Promise<void>`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/events.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, organizations } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { recordEvent } from '../src/events';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgId = newId();
const actor: Actor = { accountId: null, memberId: newId(), orgId, orgRole: 'owner', tokenId: newId(), tokenScope: null };

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values({ id: orgId, slug: 'ev', name: '事件' });
});
afterAll(() => t.cleanup());

describe('recordEvent', () => {
  it('写入事件并附带 schemaVersion 与操作者', async () => {
    const subjectId = newId();
    await withOrg(t.db, orgId, (tx) =>
      recordEvent(tx, { orgId, type: 'test.happened', subjectType: 'test', subjectId, actor, payload: { a: 1 } }),
    );
    const rows = await withOrg(t.db, orgId, (tx) => tx.select().from(domainEvents));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'test.happened',
      subjectId,
      actorMemberId: actor.memberId,
      actorTokenId: actor.tokenId,
      payload: { schemaVersion: 1, a: 1 },
    });
  });

  it('业务事务回滚时事件一并回滚', async () => {
    await expect(
      withOrg(t.db, orgId, async (tx) => {
        await recordEvent(tx, { orgId, type: 'test.rolled_back', subjectType: 'test', subjectId: newId(), actor });
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');
    const rows = await withOrg(t.db, orgId, (tx) => tx.select().from(domainEvents));
    expect(rows.some((r) => r.type === 'test.rolled_back')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test events`
Expected: FAIL，无法解析 `../src/events`。

- [ ] **Step 3: 实现**

`packages/core/src/events.ts`：

```ts
import { domainEvents } from './db/schema';
import type { Tx } from './db/tx';
import type { Actor } from './domain-types';

export type EventInput = {
  orgId: string;
  productId?: string | null;
  type: string;
  subjectType: string;
  subjectId: string;
  actor: Actor | null;
  payload?: Record<string, unknown>;
};

/** 必须在业务修改所在的同一个事务里调用。 */
export async function recordEvent(tx: Tx, e: EventInput): Promise<void> {
  await tx.insert(domainEvents).values({
    orgId: e.orgId,
    productId: e.productId ?? null,
    type: e.type,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    actorMemberId: e.actor?.memberId ?? null,
    actorTokenId: e.actor?.tokenId ?? null,
    payload: { schemaVersion: 1, ...(e.payload ?? {}) },
  });
}
```

在 `src/index.ts` 追加 `export * from './events';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test events`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 领域事件写入"
```

---

### Task 4: 账号、密码与会话

**Files:**
- Create: `packages/core/src/auth/password.ts`, `src/auth/accounts.ts`, `src/auth/sessions.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/auth.test.ts`

**Interfaces:**
- Consumes: `Queryable`、`accounts`、`sessions`、`AppError`、`isUniqueViolation`、`randomToken`、`sha256`
- Produces:
  - `MIN_PASSWORD_LENGTH = 8`，`assertPasswordPolicy(pw: string): void`，`hashPassword(pw: string): Promise<string>`，`verifyPassword(hash: string, pw: string): Promise<boolean>`
  - `type AccountView = { id: string; email: string; name: string; isInstanceAdmin: boolean; preferences: AccountPreferences }`
  - `normalizeEmail(email: string): string`
  - `createAccount(q: Queryable, input: { email: string; name: string; password: string; isInstanceAdmin?: boolean }): Promise<AccountView>`
  - `getAccount(q: Queryable, id: string): Promise<AccountView | null>`
  - `updateProfile(q: Queryable, accountId: string, input: { name?: string; preferences?: AccountPreferences }): Promise<AccountView>`
  - `changePassword(q: Queryable, accountId: string, input: { currentPassword: string; newPassword: string }): Promise<void>`
  - `SESSION_COOKIE = 'flower_session'`，`SESSION_TTL_MS`
  - `createSession(q: Queryable, accountId: string, meta?: { ip?: string | null; userAgent?: string | null }): Promise<{ token: string; expiresAt: Date }>`
  - `resolveSession(q: Queryable, token: string): Promise<AccountView | null>`
  - `revokeSession(q: Queryable, token: string): Promise<void>`
  - `login(q: Queryable, input: { email: string; password: string }, meta?: {...}): Promise<{ token: string; expiresAt: Date; account: AccountView }>`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/auth.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changePassword, createAccount, getAccount, updateProfile } from '../src/auth/accounts';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { createSession, login, resolveSession, revokeSession } from '../src/auth/sessions';
import { AppError } from '../src/errors';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

describe('密码', () => {
  it('哈希为 argon2id，且能校验', async () => {
    const h = await hashPassword('password123');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'password123')).toBe(true);
    expect(await verifyPassword(h, 'wrong-password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('账号', () => {
  it('创建账号时邮箱统一转为小写', async () => {
    const a = await createAccount(t.db, { email: ' Alice@Example.COM ', name: 'Alice', password: 'password123' });
    expect(a.email).toBe('alice@example.com');
    expect(a.isInstanceAdmin).toBe(false);
  });

  it('重复邮箱返回 conflict', async () => {
    await expect(
      createAccount(t.db, { email: 'alice@example.com', name: 'A2', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('密码过短、邮箱格式错误、姓名为空时返回 invalid', async () => {
    await expect(createAccount(t.db, { email: 'b@example.com', name: 'B', password: 'short' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createAccount(t.db, { email: 'bad', name: 'B', password: 'password123' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createAccount(t.db, { email: 'c@example.com', name: '  ', password: 'password123' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('修改资料与密码', async () => {
    const a = await createAccount(t.db, { email: 'd@example.com', name: 'D', password: 'password123' });
    const u = await updateProfile(t.db, a.id, { name: 'Dora', preferences: { theme: 'dark' } });
    expect(u).toMatchObject({ name: 'Dora', preferences: { theme: 'dark' } });
    await expect(changePassword(t.db, a.id, { currentPassword: 'wrong-pass', newPassword: 'newpassword1' })).rejects.toMatchObject({ code: 'invalid' });
    await changePassword(t.db, a.id, { currentPassword: 'password123', newPassword: 'newpassword1' });
    await expect(login(t.db, { email: 'd@example.com', password: 'newpassword1' })).resolves.toBeTruthy();
    expect((await getAccount(t.db, a.id))?.name).toBe('Dora');
  });
});

describe('会话', () => {
  it('登录后可以用令牌解析账号，注销后失效', async () => {
    await createAccount(t.db, { email: 'e@example.com', name: 'E', password: 'password123' });
    const { token, account } = await login(t.db, { email: 'E@example.com', password: 'password123' });
    expect(account.email).toBe('e@example.com');
    expect((await resolveSession(t.db, token))?.id).toBe(account.id);
    await revokeSession(t.db, token);
    expect(await resolveSession(t.db, token)).toBeNull();
  });

  it('邮箱或密码错误时返回统一提示', async () => {
    const err1 = await login(t.db, { email: 'e@example.com', password: 'bad-password' }).catch((e) => e);
    const err2 = await login(t.db, { email: 'nobody@example.com', password: 'password123' }).catch((e) => e);
    expect(err1).toBeInstanceOf(AppError);
    expect(err1.code).toBe('unauthenticated');
    expect(err1.message).toBe(err2.message);
  });

  it('过期会话无法解析', async () => {
    const a = await createAccount(t.db, { email: 'f@example.com', name: 'F', password: 'password123' });
    const { token } = await createSession(t.db, a.id, {}, new Date(Date.now() - 1000));
    expect(await resolveSession(t.db, token)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test auth`
Expected: FAIL，无法解析 `../src/auth/*`。

- [ ] **Step 3: 实现**

`packages/core/src/auth/password.ts`：

```ts
import { hash, verify } from '@node-rs/argon2';
import { AppError } from '../errors';

export const MIN_PASSWORD_LENGTH = 8;

export function assertPasswordPolicy(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('invalid', `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
}

/** @node-rs/argon2 默认算法为 argon2id。 */
export const hashPassword = (pw: string): Promise<string> => hash(pw);

export async function verifyPassword(passwordHash: string, pw: string): Promise<boolean> {
  try {
    return await verify(passwordHash, pw);
  } catch {
    return false;
  }
}
```

`packages/core/src/auth/accounts.ts`：

```ts
import { eq } from 'drizzle-orm';
import { type AccountPreferences, accounts } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError, isUniqueViolation } from '../errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password';

export type AccountView = {
  id: string;
  email: string;
  name: string;
  isInstanceAdmin: boolean;
  preferences: AccountPreferences;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function assertName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > 50) throw new AppError('invalid', '姓名不能为空，且不超过 50 个字符');
  return n;
}

export function toAccountView(row: typeof accounts.$inferSelect): AccountView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isInstanceAdmin: row.isInstanceAdmin,
    preferences: row.preferences,
  };
}

export async function createAccount(
  q: Queryable,
  input: { email: string; name: string; password: string; isInstanceAdmin?: boolean },
): Promise<AccountView> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new AppError('invalid', '邮箱格式不正确');
  const name = assertName(input.name);
  assertPasswordPolicy(input.password);
  try {
    const [row] = await q
      .insert(accounts)
      .values({ email, name, passwordHash: await hashPassword(input.password), isInstanceAdmin: input.isInstanceAdmin ?? false })
      .returning();
    return toAccountView(row!);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '该邮箱已注册');
    throw e;
  }
}

export async function getAccount(q: Queryable, id: string): Promise<AccountView | null> {
  const [row] = await q.select().from(accounts).where(eq(accounts.id, id));
  return row ? toAccountView(row) : null;
}

export async function updateProfile(
  q: Queryable,
  accountId: string,
  input: { name?: string; preferences?: AccountPreferences },
): Promise<AccountView> {
  const current = await getAccount(q, accountId);
  if (!current) throw new AppError('not_found', '账号不存在');
  const [row] = await q
    .update(accounts)
    .set({
      name: input.name === undefined ? current.name : assertName(input.name),
      preferences: input.preferences === undefined ? current.preferences : { ...current.preferences, ...input.preferences },
    })
    .where(eq(accounts.id, accountId))
    .returning();
  return toAccountView(row!);
}

export async function changePassword(
  q: Queryable,
  accountId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const [row] = await q.select().from(accounts).where(eq(accounts.id, accountId));
  if (!row) throw new AppError('not_found', '账号不存在');
  if (!(await verifyPassword(row.passwordHash, input.currentPassword))) {
    throw new AppError('invalid', '当前密码不正确');
  }
  assertPasswordPolicy(input.newPassword);
  await q.update(accounts).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(accounts.id, accountId));
}
```

`packages/core/src/auth/sessions.ts`：

```ts
import { and, eq, gt } from 'drizzle-orm';
import { randomToken, sha256 } from '../crypto';
import { accounts, sessions } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError } from '../errors';
import { type AccountView, normalizeEmail, toAccountView } from './accounts';
import { verifyPassword } from './password';

export const SESSION_COOKIE = 'flower_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionMeta = { ip?: string | null; userAgent?: string | null };

export async function createSession(
  q: Queryable,
  accountId: string,
  meta: SessionMeta = {},
  expiresAt: Date = new Date(Date.now() + SESSION_TTL_MS),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  await q.insert(sessions).values({
    accountId,
    tokenHash: sha256(token),
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { token, expiresAt };
}

export async function resolveSession(q: Queryable, token: string): Promise<AccountView | null> {
  const [row] = await q
    .select({ account: accounts })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row ? toAccountView(row.account) : null;
}

export async function revokeSession(q: Queryable, token: string): Promise<void> {
  await q.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function login(
  q: Queryable,
  input: { email: string; password: string },
  meta: SessionMeta = {},
): Promise<{ token: string; expiresAt: Date; account: AccountView }> {
  const [row] = await q.select().from(accounts).where(eq(accounts.email, normalizeEmail(input.email)));
  if (!row || !(await verifyPassword(row.passwordHash, input.password))) {
    throw new AppError('unauthenticated', '邮箱或密码错误');
  }
  await q.update(accounts).set({ lastLoginAt: new Date() }).where(eq(accounts.id, row.id));
  const session = await createSession(q, row.id, meta);
  return { ...session, account: toAccountView(row) };
}
```

在 `src/index.ts` 追加：

```ts
export * from './auth/password';
export * from './auth/accounts';
export * from './auth/sessions';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test auth`
Expected: PASS（8 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 账号、密码与会话"
```

---

### Task 5: 权限计算

**Files:**
- Create: `packages/core/src/access/permissions.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/permissions.test.ts`

**Interfaces:**
- Consumes: `Actor`、`OrgRole`、`ProductRole`、`TokenScope`、`productMembers`、`products`、`Tx`
- Produces:
  - `baseProductRole(orgRole: OrgRole, override: ProductRole | null): ProductRole | null`
  - `capByScope(role: ProductRole | null, scope: TokenScope | null, productId: string): ProductRole | null`
  - `atLeast(role: ProductRole | null, need: ProductRole): boolean`
  - `productRoleOf(tx: Tx, actor: Actor, productId: string): Promise<ProductRole | null>`（产品不存在或已删除时返回 null）
  - `requireProductRole(tx: Tx, actor: Actor, productId: string, need: ProductRole): Promise<ProductRole>`（看不到时抛 `not_found`，看得到但不够时抛 `forbidden`）
  - `isOrgAdmin(actor: Actor): boolean`，`requireOrgAdmin(actor: Actor): void`，`requireNonGuest(actor: Actor): void`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/permissions.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  atLeast,
  baseProductRole,
  capByScope,
  isOrgAdmin,
  productRoleOf,
  requireProductRole,
} from '../src/access/permissions';
import { members, organizations, productMembers, products } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createTestDb } from './db';

describe('纯规则', () => {
  it('组织角色到默认产品角色', () => {
    expect(baseProductRole('owner', 'viewer')).toBe('admin');
    expect(baseProductRole('admin', null)).toBe('admin');
    expect(baseProductRole('member', null)).toBe('editor');
    expect(baseProductRole('member', 'viewer')).toBe('viewer');
    expect(baseProductRole('guest', null)).toBeNull();
    expect(baseProductRole('guest', 'editor')).toBe('editor');
  });

  it('Token 范围收窄权限', () => {
    expect(capByScope('admin', null, 'p1')).toBe('admin');
    expect(capByScope('admin', { products: 'all', access: 'read' }, 'p1')).toBe('viewer');
    expect(capByScope('editor', { products: ['p2'], access: 'write' }, 'p1')).toBeNull();
    expect(capByScope('editor', { products: ['p1'], access: 'write' }, 'p1')).toBe('editor');
    expect(capByScope(null, { products: 'all', access: 'write' }, 'p1')).toBeNull();
  });

  it('角色高低比较', () => {
    expect(atLeast('admin', 'editor')).toBe(true);
    expect(atLeast('viewer', 'editor')).toBe(false);
    expect(atLeast(null, 'viewer')).toBe(false);
  });

  it('组织管理员判断受 Token 范围约束', () => {
    const base: Actor = { accountId: 'a', memberId: 'm', orgId: 'o', orgRole: 'admin', tokenId: null, tokenScope: null };
    expect(isOrgAdmin(base)).toBe(true);
    expect(isOrgAdmin({ ...base, orgRole: 'member' })).toBe(false);
    expect(isOrgAdmin({ ...base, tokenId: 't', tokenScope: { products: 'all', access: 'read' } })).toBe(false);
    expect(isOrgAdmin({ ...base, tokenId: 't', tokenScope: { products: ['p'], access: 'write' } })).toBe(false);
    expect(isOrgAdmin({ ...base, tokenId: 't', tokenScope: { products: 'all', access: 'write' } })).toBe(true);
  });
});

describe('productRoleOf（读库）', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const orgId = newId();
  const productId = newId();
  const guestId = newId();
  const memberId = newId();

  beforeAll(async () => {
    t = await createTestDb();
    await t.adminDb.insert(organizations).values({ id: orgId, slug: 'perm', name: '权限' });
    await t.adminDb.insert(products).values({ id: productId, orgId, key: 'PP', name: 'P' });
    await t.adminDb.insert(members).values([
      { id: guestId, orgId, displayName: '访客', orgRole: 'guest' },
      { id: memberId, orgId, displayName: '成员', orgRole: 'member' },
    ]);
    await t.adminDb.insert(productMembers).values({ orgId, productId, memberId, role: 'viewer' });
  });
  afterAll(() => t.cleanup());

  const actor = (id: string, orgRole: Actor['orgRole']): Actor => ({
    accountId: null, memberId: id, orgId, orgRole, tokenId: null, tokenScope: null,
  });

  it('按产品覆盖计算角色', async () => {
    expect(await withOrg(t.db, orgId, (tx) => productRoleOf(tx, actor(memberId, 'member'), productId))).toBe('viewer');
    expect(await withOrg(t.db, orgId, (tx) => productRoleOf(tx, actor(guestId, 'guest'), productId))).toBeNull();
  });

  it('看不到的产品返回 not_found，权限不够返回 forbidden', async () => {
    await expect(
      withOrg(t.db, orgId, (tx) => requireProductRole(tx, actor(guestId, 'guest'), productId, 'viewer')),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      withOrg(t.db, orgId, (tx) => requireProductRole(tx, actor(memberId, 'member'), productId, 'editor')),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('不存在的产品返回 not_found', async () => {
    await expect(
      withOrg(t.db, orgId, (tx) => requireProductRole(tx, actor(memberId, 'owner'), newId(), 'viewer')),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test permissions`
Expected: FAIL，无法解析 `../src/access/permissions`。

- [ ] **Step 3: 实现**

`packages/core/src/access/permissions.ts`：

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { productMembers, products } from '../db/schema';
import type { Tx } from '../db/tx';
import type { Actor, OrgRole, ProductRole, TokenScope } from '../domain-types';
import { AppError } from '../errors';

const RANK: Record<ProductRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function baseProductRole(orgRole: OrgRole, override: ProductRole | null): ProductRole | null {
  if (orgRole === 'owner' || orgRole === 'admin') return 'admin';
  if (orgRole === 'member') return override ?? 'editor';
  return override;
}

export function capByScope(role: ProductRole | null, scope: TokenScope | null, productId: string): ProductRole | null {
  if (!role || !scope) return role;
  if (scope.products !== 'all' && !scope.products.includes(productId)) return null;
  return scope.access === 'read' ? 'viewer' : role;
}

export function atLeast(role: ProductRole | null, need: ProductRole): boolean {
  return role !== null && RANK[role] >= RANK[need];
}

export async function productRoleOf(tx: Tx, actor: Actor, productId: string): Promise<ProductRole | null> {
  const [product] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)));
  if (!product) return null;
  const [row] = await tx
    .select({ role: productMembers.role })
    .from(productMembers)
    .where(and(eq(productMembers.productId, productId), eq(productMembers.memberId, actor.memberId)));
  return capByScope(baseProductRole(actor.orgRole, row?.role ?? null), actor.tokenScope, productId);
}

export async function requireProductRole(tx: Tx, actor: Actor, productId: string, need: ProductRole): Promise<ProductRole> {
  const role = await productRoleOf(tx, actor, productId);
  if (!role) throw new AppError('not_found', '产品不存在');
  if (!atLeast(role, need)) throw new AppError('forbidden', '权限不足');
  return role;
}

export function isOrgAdmin(actor: Actor): boolean {
  if (actor.orgRole !== 'owner' && actor.orgRole !== 'admin') return false;
  if (!actor.tokenScope) return true;
  return actor.tokenScope.access === 'write' && actor.tokenScope.products === 'all';
}

export function requireOrgAdmin(actor: Actor): void {
  if (!isOrgAdmin(actor)) throw new AppError('forbidden', '需要组织管理员权限');
}

export function requireNonGuest(actor: Actor): void {
  if (actor.orgRole === 'guest') throw new AppError('forbidden', '访客无权查看此内容');
}
```

在 `src/index.ts` 追加 `export * from './access/permissions';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test permissions`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 组织与产品权限计算"
```

---

### Task 6: 流程定义的结构校验

**Files:**
- Create: `packages/core/src/definitions/workflow-schema.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/workflow-schema.test.ts`

**Interfaces:**
- Produces:
  - `STATE_CATEGORIES = ['backlog','unstarted','started','completed','canceled']`，`CHECK_STATES = ['not_started','in_progress','passed','rejected','not_needed']`
  - `workflowBodySchema`（zod），`type WorkflowBody`
  - `type ValidationIssue = { path: string; message: string }`
  - `validateWorkflowBody(input: unknown, ctx: { fieldKeys: string[] }): { ok: true; body: WorkflowBody } | { ok: false; issues: ValidationIssue[] }`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/workflow-schema.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { validateWorkflowBody } from '../src/definitions/workflow-schema';

const valid = {
  states: [
    { key: 'todo', label: '待开始', color: '#60a5fa', order: 1, group: '执行', category: 'unstarted' },
    { key: 'doing', label: '进行中', color: '#f59e0b', order: 2, group: '执行', category: 'started' },
    { key: 'done', label: '已完成', color: '#10b981', order: 3, group: '执行', category: 'completed' },
  ],
  initial: 'todo',
  transitions: [
    { from: 'todo', to: 'doing', conditions: [{ type: 'check_item', item: 'design', in: ['passed', 'not_needed'] }] },
    { from: '*', to: 'done', conditions: [{ type: 'field_set', field: 'priority' }] },
  ],
  actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'design', in: ['passed'] }] }],
  checkItems: [
    {
      key: 'design', label: '设计签字', scope: 'document', type: 'signoff',
      signers: [{ by: 'function_tag', ref: 'tag-ui' }], signoffRule: 'all',
    },
  ],
};

const issuesOf = (body: unknown) => {
  const r = validateWorkflowBody(body, { fieldKeys: ['priority'] });
  return r.ok ? [] : r.issues.map((i) => i.message);
};

describe('validateWorkflowBody', () => {
  it('合法定义通过，并补全默认值', () => {
    const r = validateWorkflowBody(valid, { fieldKeys: ['priority'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.checkItems[0]?.defaultState).toBe('not_started');
  });

  it('状态 key 重复、初始状态不存在', () => {
    const msgs = issuesOf({ ...valid, states: [...valid.states, valid.states[0]], initial: 'nope' });
    expect(msgs).toContain('状态 key「todo」重复');
    expect(msgs).toContain('初始状态「nope」不存在');
  });

  it('流转引用不存在的状态、起点终点相同、重复流转', () => {
    const msgs = issuesOf({
      ...valid,
      transitions: [
        { from: 'ghost', to: 'doing', conditions: [] },
        { from: 'doing', to: 'doing', conditions: [] },
        { from: 'todo', to: 'done', conditions: [] },
        { from: 'todo', to: 'done', conditions: [] },
      ],
    });
    expect(msgs).toContain('流转起点「ghost」不存在');
    expect(msgs).toContain('流转的起点和终点不能相同');
    expect(msgs).toContain('流转「todo->done」重复');
  });

  it('条件引用不存在的检查项或字段', () => {
    const msgs = issuesOf({
      ...valid,
      transitions: [
        { from: 'todo', to: 'doing', conditions: [{ type: 'check_item', item: 'ghost', in: ['passed'] }] },
        { from: 'doing', to: 'done', conditions: [{ type: 'field_set', field: 'nofield' }] },
      ],
    });
    expect(msgs).toContain('条件引用了不存在的检查项「ghost」');
    expect(msgs).toContain('条件引用了不存在的字段「nofield」');
  });

  it('会签检查项必须有签字人与规则，普通检查项不能有', () => {
    const msgs = issuesOf({
      ...valid,
      checkItems: [
        { key: 'design', label: '设计', scope: 'document', type: 'signoff' },
        { key: 'feas', label: '可行性', scope: 'requirement', type: 'single', signoffRule: 'all' },
      ],
    });
    expect(msgs).toContain('会签检查项必须指定签字人和会签规则');
    expect(msgs).toContain('普通检查项不能设置签字人或会签规则');
  });

  it('自动同步 PRD 状态的检查项必须作用于 PRD', () => {
    const msgs = issuesOf({
      ...valid,
      checkItems: [...valid.checkItems, { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status' }],
    });
    expect(msgs).toContain('自动同步 PRD 状态的检查项作用范围必须是 PRD');
  });

  it('结构错误（类别非法、颜色格式错误）返回带路径的问题', () => {
    const r = validateWorkflowBody(
      { ...valid, states: [{ ...valid.states[0], category: 'weird', color: 'red' }] },
      { fieldKeys: [] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'states.0.category')).toBe(true);
      expect(r.issues.some((i) => i.path === 'states.0.color' && i.message === '颜色格式应为 #RRGGBB')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test workflow-schema`
Expected: FAIL，无法解析 `../src/definitions/workflow-schema`。

- [ ] **Step 3: 实现**

`packages/core/src/definitions/workflow-schema.ts`：

```ts
import { z } from 'zod';

export const STATE_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
export const CHECK_STATES = ['not_started', 'in_progress', 'passed', 'rejected', 'not_needed'] as const;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'key 只能包含小写字母、数字和下划线，并以字母开头');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式应为 #RRGGBB');
const label = z.string().trim().min(1, '名称不能为空').max(20, '名称不超过 20 个字符');

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('check_item'), item: key, in: z.array(z.enum(CHECK_STATES)).min(1) }),
  z.object({ type: z.literal('field_set'), field: key }),
  z.object({ type: z.literal('has_iteration') }),
  z.object({ type: z.literal('has_change_document') }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const stateSchema = z.object({
  key,
  label,
  color,
  order: z.number().int(),
  group: z.string().trim().max(20).default(''),
  category: z.enum(STATE_CATEGORIES),
});

export const transitionSchema = z.object({
  from: z.union([key, z.literal('*')]),
  to: key,
  label: z.string().max(20).optional(),
  conditions: z.array(conditionSchema).default([]),
});

export const checkItemSchema = z.object({
  key,
  label,
  scope: z.enum(['requirement', 'document']),
  type: z.enum(['single', 'signoff']),
  signers: z.array(z.object({ by: z.enum(['function_tag', 'member', 'product_role']), ref: z.string().min(1) })).optional(),
  signoffRule: z.enum(['all', 'any']).optional(),
  auto: z.literal('prd_status').optional(),
  defaultState: z.enum(CHECK_STATES).default('not_started'),
});

export const workflowBodySchema = z.object({
  states: z.array(stateSchema).min(1, '至少需要一个状态'),
  initial: key,
  transitions: z.array(transitionSchema).default([]),
  actionGates: z.array(z.object({ action: z.literal('join_iteration'), conditions: z.array(conditionSchema) })).default([]),
  checkItems: z.array(checkItemSchema).default([]),
});

export type WorkflowBody = z.infer<typeof workflowBodySchema>;
export type ValidationIssue = { path: string; message: string };

export function validateWorkflowBody(
  input: unknown,
  ctx: { fieldKeys: string[] },
): { ok: true; body: WorkflowBody } | { ok: false; issues: ValidationIssue[] } {
  const parsed = workflowBodySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const b = parsed.data;
  const issues: ValidationIssue[] = [];

  const stateKeys = new Set<string>();
  b.states.forEach((s, i) => {
    if (stateKeys.has(s.key)) issues.push({ path: `states.${i}.key`, message: `状态 key「${s.key}」重复` });
    stateKeys.add(s.key);
  });
  if (!stateKeys.has(b.initial)) issues.push({ path: 'initial', message: `初始状态「${b.initial}」不存在` });

  const itemKeys = new Set<string>();
  b.checkItems.forEach((c, i) => {
    const path = `checkItems.${i}`;
    if (itemKeys.has(c.key)) issues.push({ path: `${path}.key`, message: `检查项 key「${c.key}」重复` });
    itemKeys.add(c.key);
    if (c.type === 'signoff' && (!c.signers?.length || !c.signoffRule)) {
      issues.push({ path, message: '会签检查项必须指定签字人和会签规则' });
    }
    if (c.type === 'single' && (c.signers?.length || c.signoffRule)) {
      issues.push({ path, message: '普通检查项不能设置签字人或会签规则' });
    }
    if (c.auto === 'prd_status' && c.scope !== 'document') {
      issues.push({ path: `${path}.auto`, message: '自动同步 PRD 状态的检查项作用范围必须是 PRD' });
    }
  });

  const fieldKeys = new Set(ctx.fieldKeys);
  const checkConditions = (conds: Condition[], path: string) =>
    conds.forEach((c, j) => {
      if (c.type === 'check_item' && !itemKeys.has(c.item)) {
        issues.push({ path: `${path}.${j}`, message: `条件引用了不存在的检查项「${c.item}」` });
      }
      if (c.type === 'field_set' && !fieldKeys.has(c.field)) {
        issues.push({ path: `${path}.${j}`, message: `条件引用了不存在的字段「${c.field}」` });
      }
    });

  const pairs = new Set<string>();
  b.transitions.forEach((tr, i) => {
    const path = `transitions.${i}`;
    if (tr.from !== '*' && !stateKeys.has(tr.from)) issues.push({ path: `${path}.from`, message: `流转起点「${tr.from}」不存在` });
    if (!stateKeys.has(tr.to)) issues.push({ path: `${path}.to`, message: `流转终点「${tr.to}」不存在` });
    if (tr.from === tr.to) issues.push({ path, message: '流转的起点和终点不能相同' });
    const pair = `${tr.from}->${tr.to}`;
    if (pairs.has(pair)) issues.push({ path, message: `流转「${pair}」重复` });
    pairs.add(pair);
    checkConditions(tr.conditions, `${path}.conditions`);
  });
  b.actionGates.forEach((g, i) => checkConditions(g.conditions, `actionGates.${i}.conditions`));

  return issues.length > 0 ? { ok: false, issues } : { ok: true, body: b };
}
```

在 `src/index.ts` 追加 `export * from './definitions/workflow-schema';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test workflow-schema`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 流程定义结构校验"
```

---

### Task 7: 组织创建、默认配置与操作者解析

**Files:**
- Create: `packages/core/src/definitions/defaults.ts`, `packages/core/src/tenancy/orgs.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/orgs.test.ts`

**Interfaces:**
- Consumes: `AccountView`、`withOrg`、`withSystem`、`setOrgContext`、`recordEvent`、`requireOrgAdmin`、`baseProductRole`、`WorkflowBody`
- Produces:
  - `DEFAULT_LEVEL_NAMES`、`DEFAULT_WORKFLOW_BODY: WorkflowBody`、`BUILTIN_FIELDS`、`DEFAULT_FUNCTION_TAGS`
  - `seedOrgDefaults(tx: Tx, orgId: string, createdBy: string): Promise<{ workflowDefinitionId: string; workflowVersionId: string }>`
  - `SLUG_RE`，`type OrgView = { id: string; slug: string; name: string; settings: OrgSettings }`
  - `createOrgInTx(tx: Tx, account: AccountView, input: { name: string; slug: string }): Promise<{ org: OrgView; memberId: string }>`
  - `createOrganization(db: Db, account: AccountView, input: { name: string; slug: string }): Promise<{ org: OrgView; memberId: string }>`
  - `type MyOrg = { id; slug; name; role: OrgRole; memberId: string; products: Array<{ id: string; key: string; name: string; role: ProductRole }> }`
  - `listMyOrganizations(db: Db, accountId: string): Promise<MyOrg[]>`
  - `resolveActor(db: Db, accountId: string, orgSlug: string): Promise<Actor | null>`
  - `getOrganization(db: Db, actor: Actor): Promise<OrgView>`
  - `updateOrganization(db: Db, actor: Actor, input: { name?: string; timezone?: string }): Promise<OrgView>`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/orgs.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/auth/accounts';
import { fieldDefinitions, fieldOptions, functionTags, instanceSettings, workflowDefinitions } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createOrganization, listMyOrganizations, resolveActor, updateOrganization } from '../src/tenancy/orgs';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(instanceSettings).values({ id: 1 });
});
afterAll(() => t.cleanup());

describe('组织', () => {
  it('实例管理员可以创建组织，自动成为 owner 并获得默认配置', async () => {
    const admin = await createAccount(t.db, { email: 'root@example.com', name: 'Root', password: 'password123', isInstanceAdmin: true });
    const { org, memberId } = await createOrganization(t.db, admin, { name: '123云盘', slug: 'pan' });
    expect(org.slug).toBe('pan');
    expect(org.settings.structureLevelNames).toEqual(['业务域', '模块', '功能点']);

    const actor = await resolveActor(t.db, admin.id, 'pan');
    expect(actor).toMatchObject({ memberId, orgId: org.id, orgRole: 'owner', tokenId: null });

    const defs = await withOrg(t.db, org.id, (tx) => tx.select().from(workflowDefinitions));
    expect(defs).toHaveLength(1);
    expect(defs[0]?.currentVersionId).toBeTruthy();
    const fields = await withOrg(t.db, org.id, (tx) => tx.select().from(fieldDefinitions));
    expect(fields.map((f) => f.key).sort()).toEqual(['line', 'platform', 'priority', 'source']);
    const opts = await withOrg(t.db, org.id, (tx) => tx.select().from(fieldOptions));
    expect(opts.sort((a, b) => a.sort - b.sort).map((o) => o.label)).toEqual(['P0', 'P1', 'P2', 'P3']);
    const tags = await withOrg(t.db, org.id, (tx) => tx.select().from(functionTags));
    expect(tags.sort((a, b) => a.sort - b.sort).map((x) => x.name)).toEqual(['产品经理', '设计', '开发', '测试']);
  });

  it('slug 重复与格式错误', async () => {
    const admin = await createAccount(t.db, { email: 'root2@example.com', name: 'Root2', password: 'password123', isInstanceAdmin: true });
    await expect(createOrganization(t.db, admin, { name: 'X', slug: 'pan' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(createOrganization(t.db, admin, { name: 'X', slug: 'Bad Slug' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('实例未开放建组织时，普通账号不能创建', async () => {
    const user = await createAccount(t.db, { email: 'user@example.com', name: 'User', password: 'password123' });
    await expect(createOrganization(t.db, user, { name: 'Y', slug: 'y' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('列出我加入的组织；非成员解析不到操作者', async () => {
    const admin = await createAccount(t.db, { email: 'multi@example.com', name: 'Multi', password: 'password123', isInstanceAdmin: true });
    await createOrganization(t.db, admin, { name: '甲', slug: 'jia' });
    await createOrganization(t.db, admin, { name: '乙', slug: 'yi' });
    const mine = await listMyOrganizations(t.db, admin.id);
    expect(mine.map((o) => o.slug).sort()).toEqual(['jia', 'yi']);
    expect(mine[0]?.role).toBe('owner');
    expect(await resolveActor(t.db, admin.id, 'pan')).toBeNull();
    expect(await resolveActor(t.db, admin.id, 'no-such-org')).toBeNull();
  });

  it('管理员修改组织名称与时区，并写入事件', async () => {
    const admin = await createAccount(t.db, { email: 'upd@example.com', name: 'Upd', password: 'password123', isInstanceAdmin: true });
    await createOrganization(t.db, admin, { name: '旧名', slug: 'upd' });
    const actor = (await resolveActor(t.db, admin.id, 'upd'))!;
    const org = await updateOrganization(t.db, actor, { name: '新名', timezone: 'Asia/Shanghai' });
    expect(org).toMatchObject({ name: '新名', settings: { timezone: 'Asia/Shanghai' } });
    await expect(updateOrganization(t.db, { ...actor, orgRole: 'member' }, { name: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test orgs`
Expected: FAIL，无法解析 `../src/tenancy/orgs`。

- [ ] **Step 3: 实现默认配置**

`packages/core/src/definitions/defaults.ts`：

```ts
import { eq } from 'drizzle-orm';
import { fieldDefinitions, fieldOptions, functionTags, workflowDefinitions, workflowVersions } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from './workflow-schema';

export const DEFAULT_LEVEL_NAMES = ['业务域', '模块', '功能点'];

const STATES: WorkflowBody['states'] = [
  { key: 'backlog', label: '待处理', color: '#94a3b8', order: 1, group: '规划', category: 'backlog' },
  { key: 'todo', label: '待开始', color: '#60a5fa', order: 2, group: '执行', category: 'unstarted' },
  { key: 'doing', label: '进行中', color: '#f59e0b', order: 3, group: '执行', category: 'started' },
  { key: 'done', label: '已完成', color: '#10b981', order: 4, group: '执行', category: 'completed' },
  { key: 'canceled', label: '已取消', color: '#9ca3af', order: 5, group: '执行', category: 'canceled' },
];

export const DEFAULT_WORKFLOW_BODY: WorkflowBody = {
  states: STATES,
  initial: 'backlog',
  transitions: STATES.map((s) => ({ from: '*', to: s.key, conditions: [] })),
  actionGates: [],
  checkItems: [],
};

export const BUILTIN_FIELDS: Array<{
  key: string;
  label: string;
  cardinality: 'single' | 'multi';
  options: Array<{ key: string; label: string; color: string }>;
}> = [
  {
    key: 'priority',
    label: '优先级',
    cardinality: 'single',
    options: [
      { key: 'p0', label: 'P0', color: '#dc2626' },
      { key: 'p1', label: 'P1', color: '#ea580c' },
      { key: 'p2', label: 'P2', color: '#ca8a04' },
      { key: 'p3', label: 'P3', color: '#64748b' },
    ],
  },
  { key: 'platform', label: '平台', cardinality: 'multi', options: [] },
  { key: 'source', label: '来源', cardinality: 'single', options: [] },
  { key: 'line', label: '业务线', cardinality: 'single', options: [] },
];

export const DEFAULT_FUNCTION_TAGS = [
  { name: '产品经理', color: '#0f766e' },
  { name: '设计', color: '#7c3aed' },
  { name: '开发', color: '#2563eb' },
  { name: '测试', color: '#ea580c' },
];

/** 新组织的默认配置。调用方需已在 tx 上设置该组织的上下文。 */
export async function seedOrgDefaults(
  tx: Tx,
  orgId: string,
  createdBy: string,
): Promise<{ workflowDefinitionId: string; workflowVersionId: string }> {
  const [def] = await tx.insert(workflowDefinitions).values({ orgId, name: '默认流程' }).returning();
  const [ver] = await tx
    .insert(workflowVersions)
    .values({ orgId, definitionId: def!.id, version: 1, body: DEFAULT_WORKFLOW_BODY, note: '系统默认', createdBy })
    .returning();
  await tx.update(workflowDefinitions).set({ currentVersionId: ver!.id }).where(eq(workflowDefinitions.id, def!.id));

  for (const f of BUILTIN_FIELDS) {
    const [field] = await tx
      .insert(fieldDefinitions)
      .values({ orgId, key: f.key, label: f.label, cardinality: f.cardinality, builtin: true })
      .returning();
    if (f.options.length > 0) {
      await tx.insert(fieldOptions).values(f.options.map((o, i) => ({ orgId, fieldId: field!.id, ...o, sort: i })));
    }
  }

  await tx.insert(functionTags).values(DEFAULT_FUNCTION_TAGS.map((tag, i) => ({ orgId, ...tag, sort: i })));
  return { workflowDefinitionId: def!.id, workflowVersionId: ver!.id };
}
```

- [ ] **Step 4: 实现组织服务**

`packages/core/src/tenancy/orgs.ts`：

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { requireOrgAdmin, baseProductRole } from '../access/permissions';
import type { AccountView } from '../auth/accounts';
import type { Db } from '../db/client';
import { instanceSettings, members, type OrgSettings, organizations, productMembers, products } from '../db/schema';
import { setOrgContext, type Tx, withOrg, withSystem } from '../db/tx';
import { DEFAULT_LEVEL_NAMES, seedOrgDefaults } from '../definitions/defaults';
import type { Actor, OrgRole, ProductRole } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { newId } from '../ids';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export type OrgView = { id: string; slug: string; name: string; settings: OrgSettings };

const toOrgView = (o: typeof organizations.$inferSelect): OrgView => ({ id: o.id, slug: o.slug, name: o.name, settings: o.settings });

function assertOrgInput(input: { name: string; slug: string }) {
  const name = input.name.trim();
  if (!name || name.length > 50) throw new AppError('invalid', '组织名称不能为空，且不超过 50 个字符');
  const slug = input.slug.trim();
  if (!SLUG_RE.test(slug)) throw new AppError('invalid', '组织标识只能包含小写字母、数字和连字符，长度 1–40');
  return { name, slug };
}

/** 在已有事务中创建组织（初始化向导复用）。 */
export async function createOrgInTx(
  tx: Tx,
  account: AccountView,
  input: { name: string; slug: string },
): Promise<{ org: OrgView; memberId: string }> {
  const { name, slug } = assertOrgInput(input);
  const orgId = newId();
  await setOrgContext(tx, orgId);
  let org: typeof organizations.$inferSelect;
  try {
    [org] = (await tx
      .insert(organizations)
      .values({ id: orgId, slug, name, settings: { structureLevelNames: DEFAULT_LEVEL_NAMES } })
      .returning()) as [typeof organizations.$inferSelect];
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '该组织标识已被使用');
    throw e;
  }
  const [member] = await tx
    .insert(members)
    .values({ orgId, accountId: account.id, displayName: account.name, email: account.email, orgRole: 'owner' })
    .returning();
  await seedOrgDefaults(tx, orgId, member!.id);
  const actor: Actor = { accountId: account.id, memberId: member!.id, orgId, orgRole: 'owner', tokenId: null, tokenScope: null };
  await recordEvent(tx, { orgId, type: 'organization.created', subjectType: 'organization', subjectId: orgId, actor, payload: { name, slug } });
  return { org: toOrgView(org), memberId: member!.id };
}

export async function createOrganization(
  db: Db,
  account: AccountView,
  input: { name: string; slug: string },
): Promise<{ org: OrgView; memberId: string }> {
  return db.transaction(async (tx) => {
    if (!account.isInstanceAdmin) {
      const [settings] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
      if (!settings?.allowOrgCreation) throw new AppError('forbidden', '当前实例不允许用户自行创建组织');
    }
    return createOrgInTx(tx, account, input);
  });
}

export type MyOrg = {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
  memberId: string;
  products: Array<{ id: string; key: string; name: string; role: ProductRole }>;
};

/** 跨组织查询：列出账号加入的全部组织及其可见产品。 */
export async function listMyOrganizations(db: Db, accountId: string): Promise<MyOrg[]> {
  return withSystem(db, async (tx) => {
    const rows = await tx
      .select({ org: organizations, member: members })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.orgId))
      .where(and(eq(members.accountId, accountId), eq(members.status, 'active'), isNull(organizations.deletedAt)))
      .orderBy(organizations.createdAt);
    if (rows.length === 0) return [];
    const orgIds = rows.map((r) => r.org.id);
    const memberIds = rows.map((r) => r.member.id);
    const prods = await tx
      .select()
      .from(products)
      .where(and(inArray(products.orgId, orgIds), isNull(products.deletedAt)))
      .orderBy(products.createdAt);
    const overrides = await tx.select().from(productMembers).where(inArray(productMembers.memberId, memberIds));
    return rows.map(({ org, member }) => ({
      id: org.id,
      slug: org.slug,
      name: org.name,
      role: member.orgRole,
      memberId: member.id,
      products: prods
        .filter((p) => p.orgId === org.id)
        .flatMap((p) => {
          const o = overrides.find((x) => x.productId === p.id && x.memberId === member.id);
          const role = baseProductRole(member.orgRole, o?.role ?? null);
          return role ? [{ id: p.id, key: p.key, name: p.name, role }] : [];
        }),
    }));
  });
}

/** 跨组织查询：按组织标识找到该账号的成员身份。 */
export async function resolveActor(db: Db, accountId: string, orgSlug: string): Promise<Actor | null> {
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ member: members })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.orgId))
      .where(
        and(
          eq(organizations.slug, orgSlug),
          isNull(organizations.deletedAt),
          eq(members.accountId, accountId),
          eq(members.status, 'active'),
        ),
      );
    if (!row) return null;
    return {
      accountId,
      memberId: row.member.id,
      orgId: row.member.orgId,
      orgRole: row.member.orgRole,
      tokenId: null,
      tokenScope: null,
    };
  });
}

export async function getOrganization(db: Db, actor: Actor): Promise<OrgView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.orgId));
    if (!org) throw new AppError('not_found', '组织不存在');
    return toOrgView(org);
  });
}

export async function updateOrganization(db: Db, actor: Actor, input: { name?: string; timezone?: string }): Promise<OrgView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(organizations).where(eq(organizations.id, actor.orgId));
    if (!cur) throw new AppError('not_found', '组织不存在');
    const name = input.name === undefined ? cur.name : assertOrgInput({ name: input.name, slug: cur.slug }).name;
    const settings = input.timezone === undefined ? cur.settings : { ...cur.settings, timezone: input.timezone };
    const [org] = await tx.update(organizations).set({ name, settings }).where(eq(organizations.id, actor.orgId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'organization.updated',
      subjectType: 'organization',
      subjectId: actor.orgId,
      actor,
      payload: { changes: [{ field: 'name', old: cur.name, new: name }] },
    });
    return toOrgView(org!);
  });
}
```

在 `src/index.ts` 追加：

```ts
export * from './definitions/defaults';
export * from './tenancy/orgs';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core test orgs`
Expected: PASS（5 个用例）。

- [ ] **Step 6: 提交**

```bash
git add packages/core
git commit -m "feat(core): 组织创建、默认配置与操作者解析"
```

---

### Task 8: 实例初始化、注册与测试工厂

**Files:**
- Create: `packages/core/src/setup/instance.ts`, `packages/core/test/factories.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/instance.test.ts`

**Interfaces:**
- Consumes: `createAccount`、`createOrgInTx`、`resolveActor`、`instanceSettings`
- Produces:
  - `type InstanceStatus = { initialized: boolean; allowSignup: boolean; allowOrgCreation: boolean }`
  - `getInstanceStatus(db: Db): Promise<InstanceStatus>`
  - `initializeInstance(db: Db, input: { admin: { email: string; name: string; password: string }; org: { name: string; slug: string } }): Promise<{ account: AccountView; org: OrgView; memberId: string }>`
  - `updateInstanceSettings(db: Db, account: AccountView, patch: { allowSignup?: boolean; allowOrgCreation?: boolean }): Promise<InstanceStatus>`
  - `signUp(db: Db, input: { email: string; name: string; password: string }): Promise<AccountView>`
  - 测试工厂：`seedInstance(db: Db): Promise<{ account: AccountView; org: OrgView; owner: Actor }>`，`OWNER_EMAIL = 'owner@example.com'`，`OWNER_PASSWORD = 'password123'`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/instance.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from '../src/auth/sessions';
import { getInstanceStatus, initializeInstance, signUp, updateInstanceSettings } from '../src/setup/instance';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

const input = {
  admin: { email: 'owner@example.com', name: 'Owner', password: 'password123' },
  org: { name: '123云盘', slug: 'pan' },
};

describe('实例初始化', () => {
  it('初始化前状态为未初始化、默认邀请制', async () => {
    expect(await getInstanceStatus(t.db)).toEqual({ initialized: false, allowSignup: false, allowOrgCreation: false });
  });

  it('初始化创建实例管理员与第一个组织', async () => {
    const r = await initializeInstance(t.db, input);
    expect(r.account.isInstanceAdmin).toBe(true);
    expect(r.org.slug).toBe('pan');
    expect((await getInstanceStatus(t.db)).initialized).toBe(true);
  });

  it('不能重复初始化', async () => {
    await expect(
      initializeInstance(t.db, { ...input, admin: { ...input.admin, email: 'x@example.com' }, org: { name: 'X', slug: 'x' } }),
    ).rejects.toMatchObject({ code: 'already_initialized' });
  });

  it('默认不开放注册', async () => {
    await expect(signUp(t.db, { email: 'new@example.com', name: 'New', password: 'password123' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('实例管理员开放注册后可以注册；只有实例管理员能修改实例设置', async () => {
    const { account: ownerView } = await login(t.db, { email: 'owner@example.com', password: 'password123' });
    const status = await updateInstanceSettings(t.db, ownerView, { allowSignup: true });
    expect(status.allowSignup).toBe(true);
    const created = await signUp(t.db, { email: 'new@example.com', name: 'New', password: 'password123' });
    expect(created.isInstanceAdmin).toBe(false);
    await expect(updateInstanceSettings(t.db, created, { allowOrgCreation: true })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test instance`
Expected: FAIL，无法解析 `../src/setup/instance`。

- [ ] **Step 3: 实现**

`packages/core/src/setup/instance.ts`：

```ts
import { eq, sql } from 'drizzle-orm';
import { type AccountView, createAccount } from '../auth/accounts';
import type { Db } from '../db/client';
import { instanceSettings } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError } from '../errors';
import { createOrgInTx, type OrgView } from '../tenancy/orgs';

export type InstanceStatus = { initialized: boolean; allowSignup: boolean; allowOrgCreation: boolean };

const SETUP_LOCK = 4_242_001;

async function readStatus(q: Queryable): Promise<InstanceStatus> {
  const [row] = await q.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
  return {
    initialized: Boolean(row?.initializedAt),
    allowSignup: row?.allowSignup ?? false,
    allowOrgCreation: row?.allowOrgCreation ?? false,
  };
}

export const getInstanceStatus = (db: Db): Promise<InstanceStatus> => readStatus(db);

export async function initializeInstance(
  db: Db,
  input: { admin: { email: string; name: string; password: string }; org: { name: string; slug: string } },
): Promise<{ account: AccountView; org: OrgView; memberId: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    if ((await readStatus(tx)).initialized) throw new AppError('already_initialized', '实例已完成初始化');
    await tx
      .insert(instanceSettings)
      .values({ id: 1, initializedAt: new Date() })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { initializedAt: new Date(), updatedAt: new Date() } });
    const account = await createAccount(tx, { ...input.admin, isInstanceAdmin: true });
    const { org, memberId } = await createOrgInTx(tx, account, input.org);
    return { account, org, memberId };
  });
}

export async function updateInstanceSettings(
  db: Db,
  account: AccountView,
  patch: { allowSignup?: boolean; allowOrgCreation?: boolean },
): Promise<InstanceStatus> {
  if (!account.isInstanceAdmin) throw new AppError('forbidden', '需要实例管理员权限');
  await db
    .update(instanceSettings)
    .set({
      ...(patch.allowSignup === undefined ? {} : { allowSignup: patch.allowSignup }),
      ...(patch.allowOrgCreation === undefined ? {} : { allowOrgCreation: patch.allowOrgCreation }),
      updatedAt: new Date(),
    })
    .where(eq(instanceSettings.id, 1));
  return readStatus(db);
}

export async function signUp(db: Db, input: { email: string; name: string; password: string }): Promise<AccountView> {
  const status = await readStatus(db);
  if (!status.initialized || !status.allowSignup) throw new AppError('forbidden', '当前实例仅支持邀请加入');
  return createAccount(db, input);
}
```

`packages/core/test/factories.ts`：

```ts
import type { AccountView } from '../src/auth/accounts';
import type { Db } from '../src/db/client';
import type { Actor } from '../src/domain-types';
import { initializeInstance } from '../src/setup/instance';
import { type OrgView, resolveActor } from '../src/tenancy/orgs';

export const OWNER_EMAIL = 'owner@example.com';
export const OWNER_PASSWORD = 'password123';

/** 初始化实例，返回实例管理员账号、组织 acme 及其 owner 操作者。 */
export async function seedInstance(db: Db): Promise<{ account: AccountView; org: OrgView; owner: Actor }> {
  const { account, org } = await initializeInstance(db, {
    admin: { email: OWNER_EMAIL, name: 'Owner', password: OWNER_PASSWORD },
    org: { name: '测试组织', slug: 'acme' },
  });
  const owner = await resolveActor(db, account.id, 'acme');
  if (!owner) throw new Error('seedInstance: 无法解析 owner');
  return { account, org, owner };
}
```

在 `src/index.ts` 追加 `export * from './setup/instance';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test instance`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 实例初始化、注册开关与测试工厂"
```

---

### Task 9: 产品与产品角色

**Files:**
- Create: `packages/core/src/tenancy/products.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/products.test.ts`

**Interfaces:**
- Consumes: `withOrg`、`requireOrgAdmin`、`requireProductRole`、`productRoleOf`、`recordEvent`、`seedInstance`
- Produces:
  - `PRODUCT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/`
  - `type ProductView = { id: string; key: string; name: string; status: 'active' | 'archived'; workflowVersionId: string | null; structureLevelNames: string[] | null; myRole: ProductRole }`
  - `createProduct(db: Db, actor: Actor, input: { name: string; key: string; workflowVersionId?: string }): Promise<ProductView>`
  - `listProducts(db: Db, actor: Actor): Promise<ProductView[]>`
  - `getProduct(db: Db, actor: Actor, productId: string): Promise<ProductView>`
  - `updateProduct(db: Db, actor: Actor, productId: string, input: { name?: string; status?: 'active' | 'archived' }): Promise<ProductView>`
  - `listProductRoles(db: Db, actor: Actor, productId: string): Promise<Array<{ memberId: string; role: ProductRole }>>`
  - `setProductRole(db: Db, actor: Actor, productId: string, memberId: string, role: ProductRole | null): Promise<void>`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/products.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { members } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createProduct, getProduct, listProductRoles, listProducts, setProductRole, updateProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let member: Actor;
let guest: Actor;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const memberId = newId();
  const guestId = newId();
  await t.adminDb.insert(members).values([
    { id: memberId, orgId: owner.orgId, displayName: '成员', orgRole: 'member' },
    { id: guestId, orgId: owner.orgId, displayName: '访客', orgRole: 'guest' },
  ]);
  member = { ...owner, accountId: null, memberId, orgRole: 'member' };
  guest = { ...owner, accountId: null, memberId: guestId, orgRole: 'guest' };
});
afterAll(() => t.cleanup());

describe('产品', () => {
  it('组织管理员创建产品，默认使用组织的默认流程', async () => {
    const p = await createProduct(t.db, owner, { name: '网盘', key: 'pan' });
    expect(p).toMatchObject({ key: 'PAN', name: '网盘', status: 'active', myRole: 'admin' });
    expect(p.workflowVersionId).toBeTruthy();
  });

  it('前缀重复或格式错误', async () => {
    await expect(createProduct(t.db, owner, { name: '重复', key: 'PAN' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(createProduct(t.db, owner, { name: '坏前缀', key: '1X' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('普通成员不能创建产品', async () => {
    await expect(createProduct(t.db, member, { name: 'X', key: 'XX' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('可见性：成员默认可编辑，访客默认看不到，授权后可见', async () => {
    const p = await createProduct(t.db, owner, { name: '会员', key: 'VIP' });
    expect((await listProducts(t.db, member)).map((x) => x.key)).toContain('VIP');
    expect((await getProduct(t.db, member, p.id)).myRole).toBe('editor');
    expect(await listProducts(t.db, guest)).toHaveLength(0);
    await expect(getProduct(t.db, guest, p.id)).rejects.toMatchObject({ code: 'not_found' });

    await setProductRole(t.db, owner, p.id, guest.memberId, 'viewer');
    expect((await getProduct(t.db, guest, p.id)).myRole).toBe('viewer');
    expect(await listProductRoles(t.db, owner, p.id)).toEqual([{ memberId: guest.memberId, role: 'viewer' }]);

    await setProductRole(t.db, owner, p.id, guest.memberId, null);
    await expect(getProduct(t.db, guest, p.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('不能给组织管理员单独设置产品角色', async () => {
    const p = await createProduct(t.db, owner, { name: '管理', key: 'ADM' });
    await expect(setProductRole(t.db, owner, p.id, owner.memberId, 'viewer')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('产品管理员可以改名和归档，编辑者不行', async () => {
    const p = await createProduct(t.db, owner, { name: '旧', key: 'OLD' });
    const u = await updateProduct(t.db, owner, p.id, { name: '新', status: 'archived' });
    expect(u).toMatchObject({ name: '新', status: 'archived' });
    await expect(updateProduct(t.db, member, p.id, { name: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test products`
Expected: FAIL，无法解析 `../src/tenancy/products`。

- [ ] **Step 3: 实现**

`packages/core/src/tenancy/products.ts`：

```ts
import { and, asc, eq, isNull } from 'drizzle-orm';
import { productRoleOf, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { members, productMembers, products, workflowDefinitions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';

export const PRODUCT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

export type ProductView = {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
  workflowVersionId: string | null;
  structureLevelNames: string[] | null;
  myRole: ProductRole;
};

const toView = (p: typeof products.$inferSelect, myRole: ProductRole): ProductView => ({
  id: p.id,
  key: p.key,
  name: p.name,
  status: p.status,
  workflowVersionId: p.workflowVersionId,
  structureLevelNames: p.structureLevelNames,
  myRole,
});

function assertName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '产品名称不能为空，且不超过 50 个字符');
  return n;
}

async function loadProduct(tx: Tx, productId: string) {
  const [p] = await tx.select().from(products).where(and(eq(products.id, productId), isNull(products.deletedAt)));
  if (!p) throw new AppError('not_found', '产品不存在');
  return p;
}

async function defaultWorkflowVersion(tx: Tx): Promise<string | null> {
  const [def] = await tx
    .select()
    .from(workflowDefinitions)
    .where(and(isNull(workflowDefinitions.productId), isNull(workflowDefinitions.archivedAt)))
    .orderBy(asc(workflowDefinitions.createdAt))
    .limit(1);
  return def?.currentVersionId ?? null;
}

export async function createProduct(
  db: Db,
  actor: Actor,
  input: { name: string; key: string; workflowVersionId?: string },
): Promise<ProductView> {
  requireOrgAdmin(actor);
  const name = assertName(input.name);
  const key = input.key.trim().toUpperCase();
  if (!PRODUCT_KEY_RE.test(key)) throw new AppError('invalid', '编号前缀须以字母开头，由 2–10 位大写字母或数字组成');
  return withOrg(db, actor.orgId, async (tx) => {
    const workflowVersionId = input.workflowVersionId ?? (await defaultWorkflowVersion(tx));
    let row: typeof products.$inferSelect;
    try {
      [row] = (await tx
        .insert(products)
        .values({ orgId: actor.orgId, name, key, workflowVersionId })
        .returning()) as [typeof products.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', `编号前缀 ${key} 已被使用`);
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: row.id,
      type: 'product.created',
      subjectType: 'product',
      subjectId: row.id,
      actor,
      payload: { name, key },
    });
    return toView(row, 'admin');
  });
}

export async function listProducts(db: Db, actor: Actor): Promise<ProductView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx.select().from(products).where(isNull(products.deletedAt)).orderBy(asc(products.createdAt));
    const result: ProductView[] = [];
    for (const p of rows) {
      const role = await productRoleOf(tx, actor, p.id);
      if (role) result.push(toView(p, role));
    }
    return result;
  });
}

export async function getProduct(db: Db, actor: Actor, productId: string): Promise<ProductView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'viewer');
    return toView(await loadProduct(tx, productId), role);
  });
}

export async function updateProduct(
  db: Db,
  actor: Actor,
  productId: string,
  input: { name?: string; status?: 'active' | 'archived' },
): Promise<ProductView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'admin');
    const cur = await loadProduct(tx, productId);
    const name = input.name === undefined ? cur.name : assertName(input.name);
    const status = input.status ?? cur.status;
    const [row] = await tx.update(products).set({ name, status }).where(eq(products.id, productId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'product.updated',
      subjectType: 'product',
      subjectId: productId,
      actor,
      payload: {
        changes: [
          { field: 'name', old: cur.name, new: name },
          { field: 'status', old: cur.status, new: status },
        ].filter((c) => c.old !== c.new),
      },
    });
    return toView(row!, role);
  });
}

export async function listProductRoles(db: Db, actor: Actor, productId: string): Promise<Array<{ memberId: string; role: ProductRole }>> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    return tx
      .select({ memberId: productMembers.memberId, role: productMembers.role })
      .from(productMembers)
      .where(eq(productMembers.productId, productId));
  });
}

export async function setProductRole(
  db: Db,
  actor: Actor,
  productId: string,
  memberId: string,
  role: ProductRole | null,
): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [target] = await tx.select().from(members).where(eq(members.id, memberId));
    if (!target) throw new AppError('not_found', '成员不存在');
    if (target.orgRole === 'owner' || target.orgRole === 'admin') {
      throw new AppError('invalid', '组织管理员在所有产品上都是管理员，无需单独设置');
    }
    await tx
      .delete(productMembers)
      .where(and(eq(productMembers.productId, productId), eq(productMembers.memberId, memberId)));
    if (role) await tx.insert(productMembers).values({ orgId: actor.orgId, productId, memberId, role });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'product.member_role_set',
      subjectType: 'member',
      subjectId: memberId,
      actor,
      payload: { role },
    });
  });
}
```

在 `src/index.ts` 追加 `export * from './tenancy/products';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test products`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 产品与产品级角色"
```

---

### Task 10: 成员、Agent 成员与职能标签

**Files:**
- Create: `packages/core/src/tenancy/members.ts`, `packages/core/src/tenancy/function-tags.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/members.test.ts`

**Interfaces:**
- Consumes: `withOrg`、`requireOrgAdmin`、`requireNonGuest`、`recordEvent`、`seedInstance`
- Produces:
  - `type MemberView = { id: string; kind: 'human' | 'agent'; displayName: string; email: string | null; department: string | null; orgRole: OrgRole; status: 'active' | 'left'; hasAccount: boolean; functionTagIds: string[]; productRoles: Array<{ productId: string; role: ProductRole }> }`
  - `listMembers(db: Db, actor: Actor): Promise<MemberView[]>`
  - `createPlaceholderMember(db: Db, actor: Actor, input: { displayName: string; email?: string; department?: string }): Promise<MemberView>`
  - `createAgentMember(db: Db, actor: Actor, input: { displayName: string; orgRole?: 'member' | 'guest' }): Promise<MemberView>`
  - `updateMember(db: Db, actor: Actor, memberId: string, input: { displayName?: string; email?: string | null; department?: string | null; orgRole?: OrgRole; status?: 'active' | 'left' }): Promise<MemberView>`
  - `setMemberFunctionTags(db: Db, actor: Actor, memberId: string, tagIds: string[]): Promise<MemberView>`
  - `type FunctionTagView = { id: string; name: string; color: string; sort: number }`
  - `listFunctionTags(db, actor)`、`createFunctionTag(db, actor, { name, color })`、`updateFunctionTag(db, actor, id, { name?, color?, sort? })`、`deleteFunctionTag(db, actor, id)`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/members.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { createFunctionTag, deleteFunctionTag, listFunctionTags, updateFunctionTag } from '../src/tenancy/function-tags';
import { createAgentMember, createPlaceholderMember, listMembers, setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
});
afterAll(() => t.cleanup());

describe('成员', () => {
  it('登记无账号成员，列表中标明没有账号', async () => {
    const m = await createPlaceholderMember(t.db, owner, { displayName: '王总', department: '商务部' });
    expect(m).toMatchObject({ kind: 'human', hasAccount: false, orgRole: 'member', department: '商务部' });
    const list = await listMembers(t.db, owner);
    expect(list.map((x) => x.displayName)).toEqual(expect.arrayContaining(['Owner', '王总']));
    expect(list.find((x) => x.displayName === 'Owner')?.hasAccount).toBe(true);
  });

  it('创建 Agent 成员，不能设为管理员', async () => {
    const a = await createAgentMember(t.db, owner, { displayName: 'PRD 助手' });
    expect(a).toMatchObject({ kind: 'agent', orgRole: 'member', hasAccount: false });
    await expect(updateMember(t.db, owner, a.id, { orgRole: 'admin' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('只有 owner 能授予或撤销 owner；不能移除最后一个 owner', async () => {
    const m = await createPlaceholderMember(t.db, owner, { displayName: '李四' });
    const adminActor: Actor = { ...owner, memberId: m.id, orgRole: 'admin' };
    await expect(updateMember(t.db, adminActor, m.id, { orgRole: 'owner' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateMember(t.db, owner, owner.memberId, { orgRole: 'admin' })).rejects.toMatchObject({ code: 'invalid' });
    const promoted = await updateMember(t.db, owner, m.id, { orgRole: 'admin', department: '研发部' });
    expect(promoted).toMatchObject({ orgRole: 'admin', department: '研发部' });
  });

  it('普通成员不能登记成员', async () => {
    await expect(createPlaceholderMember(t.db, { ...owner, orgRole: 'member' }, { displayName: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('访客不能查看成员列表', async () => {
    await expect(listMembers(t.db, { ...owner, orgRole: 'guest' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('职能标签', () => {
  it('默认有四个标签，可以增改删，并分配给成员', async () => {
    expect((await listFunctionTags(t.db, owner)).map((x) => x.name)).toEqual(['产品经理', '设计', '开发', '测试']);
    const tag = await createFunctionTag(t.db, owner, { name: '线条负责人', color: '#be123c' });
    await expect(createFunctionTag(t.db, owner, { name: '线条负责人', color: '#be123c' })).rejects.toMatchObject({ code: 'conflict' });
    const renamed = await updateFunctionTag(t.db, owner, tag.id, { name: '业务线负责人' });
    expect(renamed.name).toBe('业务线负责人');

    const m = await createPlaceholderMember(t.db, owner, { displayName: '赵六' });
    const withTag = await setMemberFunctionTags(t.db, owner, m.id, [tag.id]);
    expect(withTag.functionTagIds).toEqual([tag.id]);

    await deleteFunctionTag(t.db, owner, tag.id);
    const after = (await listMembers(t.db, owner)).find((x) => x.id === m.id);
    expect(after?.functionTagIds).toEqual([]);
  });

  it('颜色格式错误', async () => {
    await expect(createFunctionTag(t.db, owner, { name: 'X', color: 'red' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test members`
Expected: FAIL，无法解析 `../src/tenancy/members`。

- [ ] **Step 3: 实现职能标签**

`packages/core/src/tenancy/function-tags.ts`：

```ts
import { asc, eq } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { functionTags } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';

export type FunctionTagView = { id: string; name: string; color: string; sort: number };

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function assertTag(input: { name?: string; color?: string }) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 20)) {
    throw new AppError('invalid', '标签名称不能为空，且不超过 20 个字符');
  }
  if (input.color !== undefined && !COLOR_RE.test(input.color)) throw new AppError('invalid', '颜色格式应为 #RRGGBB');
}

const view = (r: typeof functionTags.$inferSelect): FunctionTagView => ({ id: r.id, name: r.name, color: r.color, sort: r.sort });

export async function listFunctionTags(db: Db, actor: Actor): Promise<FunctionTagView[]> {
  requireNonGuest(actor);
  return withOrg(db, actor.orgId, async (tx) =>
    (await tx.select().from(functionTags).orderBy(asc(functionTags.sort), asc(functionTags.name))).map(view),
  );
}

export async function createFunctionTag(db: Db, actor: Actor, input: { name: string; color: string }): Promise<FunctionTagView> {
  requireOrgAdmin(actor);
  assertTag(input);
  return withOrg(db, actor.orgId, async (tx) => {
    const existing = await tx.select().from(functionTags);
    try {
      const [row] = await tx
        .insert(functionTags)
        .values({ orgId: actor.orgId, name: input.name.trim(), color: input.color, sort: existing.length })
        .returning();
      await recordEvent(tx, { orgId: actor.orgId, type: 'function_tag.created', subjectType: 'function_tag', subjectId: row!.id, actor, payload: { name: row!.name } });
      return view(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已存在同名标签');
      throw e;
    }
  });
}

export async function updateFunctionTag(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; color?: string; sort?: number },
): Promise<FunctionTagView> {
  requireOrgAdmin(actor);
  assertTag(input);
  return withOrg(db, actor.orgId, async (tx) => {
    try {
      const [row] = await tx
        .update(functionTags)
        .set({
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.color === undefined ? {} : { color: input.color }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
        })
        .where(eq(functionTags.id, id))
        .returning();
      if (!row) throw new AppError('not_found', '标签不存在');
      await recordEvent(tx, { orgId: actor.orgId, type: 'function_tag.updated', subjectType: 'function_tag', subjectId: id, actor, payload: input });
      return view(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已存在同名标签');
      throw e;
    }
  });
}

export async function deleteFunctionTag(db: Db, actor: Actor, id: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.delete(functionTags).where(eq(functionTags.id, id)).returning();
    if (!row) throw new AppError('not_found', '标签不存在');
    await recordEvent(tx, { orgId: actor.orgId, type: 'function_tag.deleted', subjectType: 'function_tag', subjectId: id, actor, payload: { name: row.name } });
  });
}
```

`member_function_tags.tag_id` 已设置 `onDelete: 'cascade'`，删除标签时成员上的标签随之移除。

- [ ] **Step 4: 实现成员服务**

`packages/core/src/tenancy/members.ts`：

```ts
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { functionTags, memberFunctionTags, members, productMembers } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, OrgRole, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';

export type MemberView = {
  id: string;
  kind: 'human' | 'agent';
  displayName: string;
  email: string | null;
  department: string | null;
  orgRole: OrgRole;
  status: 'active' | 'left';
  hasAccount: boolean;
  functionTagIds: string[];
  productRoles: Array<{ productId: string; role: ProductRole }>;
};

function assertDisplayName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '名称不能为空，且不超过 50 个字符');
  return n;
}

async function loadViews(tx: Tx, ids?: string[]): Promise<MemberView[]> {
  const rows = await tx
    .select()
    .from(members)
    .where(ids ? inArray(members.id, ids) : undefined)
    .orderBy(asc(members.createdAt));
  if (rows.length === 0) return [];
  const memberIds = rows.map((r) => r.id);
  const tags = await tx.select().from(memberFunctionTags).where(inArray(memberFunctionTags.memberId, memberIds));
  const roles = await tx.select().from(productMembers).where(inArray(productMembers.memberId, memberIds));
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    displayName: m.displayName,
    email: m.email,
    department: m.department,
    orgRole: m.orgRole,
    status: m.status,
    hasAccount: m.accountId !== null,
    functionTagIds: tags.filter((x) => x.memberId === m.id).map((x) => x.tagId),
    productRoles: roles.filter((x) => x.memberId === m.id).map((x) => ({ productId: x.productId, role: x.role })),
  }));
}

async function loadOne(tx: Tx, id: string): Promise<MemberView> {
  const [v] = await loadViews(tx, [id]);
  if (!v) throw new AppError('not_found', '成员不存在');
  return v;
}

export async function listMembers(db: Db, actor: Actor): Promise<MemberView[]> {
  requireNonGuest(actor);
  return withOrg(db, actor.orgId, (tx) => loadViews(tx));
}

export async function createPlaceholderMember(
  db: Db,
  actor: Actor,
  input: { displayName: string; email?: string; department?: string },
): Promise<MemberView> {
  requireOrgAdmin(actor);
  const displayName = assertDisplayName(input.displayName);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .insert(members)
      .values({
        orgId: actor.orgId,
        displayName,
        email: input.email?.trim().toLowerCase() || null,
        department: input.department?.trim() || null,
        orgRole: 'member',
      })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.created', subjectType: 'member', subjectId: row!.id, actor, payload: { displayName, hasAccount: false } });
    return loadOne(tx, row!.id);
  });
}

export async function createAgentMember(
  db: Db,
  actor: Actor,
  input: { displayName: string; orgRole?: 'member' | 'guest' },
): Promise<MemberView> {
  requireOrgAdmin(actor);
  const displayName = assertDisplayName(input.displayName);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .insert(members)
      .values({ orgId: actor.orgId, kind: 'agent', displayName, orgRole: input.orgRole ?? 'member' })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.agent_created', subjectType: 'member', subjectId: row!.id, actor, payload: { displayName } });
    return loadOne(tx, row!.id);
  });
}

export async function updateMember(
  db: Db,
  actor: Actor,
  memberId: string,
  input: { displayName?: string; email?: string | null; department?: string | null; orgRole?: OrgRole; status?: 'active' | 'left' },
): Promise<MemberView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(members).where(eq(members.id, memberId));
    if (!cur) throw new AppError('not_found', '成员不存在');
    const nextRole = input.orgRole ?? cur.orgRole;
    const nextStatus = input.status ?? cur.status;

    if (cur.kind === 'agent' && (nextRole === 'owner' || nextRole === 'admin')) {
      throw new AppError('invalid', 'Agent 成员不能担任组织管理员');
    }
    if ((nextRole === 'owner') !== (cur.orgRole === 'owner') && actor.orgRole !== 'owner') {
      throw new AppError('forbidden', '只有 owner 能授予或撤销 owner');
    }
    const losingOwner = cur.orgRole === 'owner' && (nextRole !== 'owner' || nextStatus !== 'active');
    if (losingOwner) {
      const others = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.orgRole, 'owner'), eq(members.status, 'active'), ne(members.id, memberId)));
      if (others.length === 0) throw new AppError('invalid', '组织至少需要保留一个 owner');
    }

    await tx
      .update(members)
      .set({
        displayName: input.displayName === undefined ? cur.displayName : assertDisplayName(input.displayName),
        email: input.email === undefined ? cur.email : input.email?.trim().toLowerCase() || null,
        department: input.department === undefined ? cur.department : input.department?.trim() || null,
        orgRole: nextRole,
        status: nextStatus,
      })
      .where(eq(members.id, memberId));
    if (nextRole === 'owner' || nextRole === 'admin') {
      await tx.delete(productMembers).where(eq(productMembers.memberId, memberId));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'member.updated',
      subjectType: 'member',
      subjectId: memberId,
      actor,
      payload: {
        changes: [
          { field: 'orgRole', old: cur.orgRole, new: nextRole },
          { field: 'status', old: cur.status, new: nextStatus },
        ].filter((c) => c.old !== c.new),
      },
    });
    return loadOne(tx, memberId);
  });
}

export async function setMemberFunctionTags(db: Db, actor: Actor, memberId: string, tagIds: string[]): Promise<MemberView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    await loadOne(tx, memberId);
    const unique = [...new Set(tagIds)];
    if (unique.length > 0) {
      const found = await tx.select({ id: functionTags.id }).from(functionTags).where(inArray(functionTags.id, unique));
      if (found.length !== unique.length) throw new AppError('invalid', '包含不存在的职能标签');
    }
    await tx.delete(memberFunctionTags).where(eq(memberFunctionTags.memberId, memberId));
    if (unique.length > 0) {
      await tx.insert(memberFunctionTags).values(unique.map((tagId) => ({ orgId: actor.orgId, memberId, tagId })));
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.function_tags_set', subjectType: 'member', subjectId: memberId, actor, payload: { tagIds: unique } });
    return loadOne(tx, memberId);
  });
}
```

在 `src/index.ts` 追加：

```ts
export * from './tenancy/members';
export * from './tenancy/function-tags';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core test members`
Expected: PASS（7 个用例）。

- [ ] **Step 6: 提交**

```bash
git add packages/core
git commit -m "feat(core): 成员、Agent 成员与职能标签"
```

---

### Task 11: 邀请

**Files:**
- Create: `packages/core/src/tenancy/invitations.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/invitations.test.ts`

**Interfaces:**
- Consumes: `createAccount`、`normalizeEmail`、`withOrg`、`withSystem`、`setOrgContext`、`requireOrgAdmin`、`recordEvent`、`randomToken`、`sha256`、`seedInstance`、`createPlaceholderMember`
- Produces:
  - `INVITATION_TTL_MS`（7 天）
  - `type InvitationView = { id: string; email: string; orgRole: 'admin' | 'member' | 'guest'; memberId: string | null; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; createdAt: Date }`
  - `createInvitation(db: Db, actor: Actor, input: { email: string; orgRole: 'admin' | 'member' | 'guest'; memberId?: string }): Promise<{ invitation: InvitationView; token: string }>`
  - `listInvitations(db: Db, actor: Actor): Promise<InvitationView[]>`
  - `revokeInvitation(db: Db, actor: Actor, invitationId: string): Promise<void>`
  - `type InvitationPreview = { orgName: string; orgSlug: string; email: string; status: 'pending' | 'expired' | 'accepted' | 'revoked'; accountExists: boolean }`
  - `previewInvitation(db: Db, token: string): Promise<InvitationPreview | null>`
  - `acceptInvitation(db: Db, token: string, who: { accountId: string } | { newAccount: { name: string; password: string } }): Promise<{ accountId: string; orgSlug: string; memberId: string }>`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/invitations.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/auth/accounts';
import type { Actor } from '../src/domain-types';
import { acceptInvitation, createInvitation, listInvitations, previewInvitation, revokeInvitation } from '../src/tenancy/invitations';
import { createPlaceholderMember, listMembers } from '../src/tenancy/members';
import { listMyOrganizations } from '../src/tenancy/orgs';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
});
afterAll(() => t.cleanup());

describe('邀请', () => {
  it('新用户通过邀请注册并加入组织', async () => {
    const { token, invitation } = await createInvitation(t.db, owner, { email: 'New@Example.com', orgRole: 'member' });
    expect(invitation.email).toBe('new@example.com');
    expect(await previewInvitation(t.db, token)).toMatchObject({ orgSlug: 'acme', status: 'pending', accountExists: false });

    const r = await acceptInvitation(t.db, token, { newAccount: { name: '新人', password: 'password123' } });
    expect(r.orgSlug).toBe('acme');
    const orgs = await listMyOrganizations(t.db, r.accountId);
    expect(orgs.map((o) => o.slug)).toEqual(['acme']);
    expect((await previewInvitation(t.db, token))?.status).toBe('accepted');
    await expect(acceptInvitation(t.db, token, { accountId: r.accountId })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('邀请绑定无账号成员，接受后该成员关联账号', async () => {
    const placeholder = await createPlaceholderMember(t.db, owner, { displayName: '王总' });
    const { token } = await createInvitation(t.db, owner, { email: 'wang@example.com', orgRole: 'member', memberId: placeholder.id });
    const r = await acceptInvitation(t.db, token, { newAccount: { name: '王某', password: 'password123' } });
    expect(r.memberId).toBe(placeholder.id);
    const m = (await listMembers(t.db, owner)).find((x) => x.id === placeholder.id);
    expect(m?.hasAccount).toBe(true);
  });

  it('已有账号的用户接受邀请，邮箱必须一致', async () => {
    const acc = await createAccount(t.db, { email: 'exist@example.com', name: '老用户', password: 'password123' });
    const other = await createAccount(t.db, { email: 'other@example.com', name: '别人', password: 'password123' });
    const { token } = await createInvitation(t.db, owner, { email: 'exist@example.com', orgRole: 'guest' });
    expect((await previewInvitation(t.db, token))?.accountExists).toBe(true);
    await expect(acceptInvitation(t.db, token, { accountId: other.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(acceptInvitation(t.db, token, { newAccount: { name: 'x', password: 'password123' } })).rejects.toMatchObject({ code: 'conflict' });
    const r = await acceptInvitation(t.db, token, { accountId: acc.id });
    expect((await listMyOrganizations(t.db, acc.id))[0]?.role).toBe('guest');
    expect(r.orgSlug).toBe('acme');
  });

  it('撤销后不能再接受；已是成员的邮箱不能再邀请', async () => {
    const { token, invitation } = await createInvitation(t.db, owner, { email: 'revoked@example.com', orgRole: 'member' });
    await revokeInvitation(t.db, owner, invitation.id);
    expect((await previewInvitation(t.db, token))?.status).toBe('revoked');
    await expect(acceptInvitation(t.db, token, { newAccount: { name: 'x', password: 'password123' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createInvitation(t.db, owner, { email: 'owner@example.com', orgRole: 'member' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await listInvitations(t.db, owner)).length).toBeGreaterThanOrEqual(4);
  });

  it('未知令牌返回 null；普通成员不能发邀请', async () => {
    expect(await previewInvitation(t.db, 'nope')).toBeNull();
    await expect(createInvitation(t.db, { ...owner, orgRole: 'member' }, { email: 'a@b.com', orgRole: 'member' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test invitations`
Expected: FAIL，无法解析 `../src/tenancy/invitations`。

- [ ] **Step 3: 实现**

`packages/core/src/tenancy/invitations.ts`：

```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import { createAccount, normalizeEmail } from '../auth/accounts';
import { randomToken, sha256 } from '../crypto';
import type { Db } from '../db/client';
import { accounts, invitations, members, organizations } from '../db/schema';
import { setOrgContext, withOrg, withSystem } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InvitationView = {
  id: string;
  email: string;
  orgRole: 'admin' | 'member' | 'guest';
  memberId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const view = (r: typeof invitations.$inferSelect): InvitationView => ({
  id: r.id,
  email: r.email,
  orgRole: r.orgRole,
  memberId: r.memberId,
  expiresAt: r.expiresAt,
  acceptedAt: r.acceptedAt,
  revokedAt: r.revokedAt,
  createdAt: r.createdAt,
});

function statusOf(r: typeof invitations.$inferSelect): 'pending' | 'expired' | 'accepted' | 'revoked' {
  if (r.acceptedAt) return 'accepted';
  if (r.revokedAt) return 'revoked';
  if (r.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

export async function createInvitation(
  db: Db,
  actor: Actor,
  input: { email: string; orgRole: 'admin' | 'member' | 'guest'; memberId?: string },
): Promise<{ invitation: InvitationView; token: string }> {
  requireOrgAdmin(actor);
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new AppError('invalid', '邮箱格式不正确');
  return withOrg(db, actor.orgId, async (tx) => {
    const [already] = await tx
      .select({ id: members.id })
      .from(members)
      .innerJoin(accounts, eq(accounts.id, members.accountId))
      .where(and(eq(accounts.email, email), eq(members.status, 'active')));
    if (already) throw new AppError('conflict', '该邮箱已是组织成员');
    if (input.memberId) {
      const [m] = await tx.select().from(members).where(eq(members.id, input.memberId));
      if (!m) throw new AppError('not_found', '成员不存在');
      if (m.kind !== 'human' || m.accountId) throw new AppError('invalid', '只能绑定没有账号的成员');
    }
    const token = randomToken();
    const [row] = await tx
      .insert(invitations)
      .values({
        orgId: actor.orgId,
        email,
        orgRole: input.orgRole,
        memberId: input.memberId ?? null,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedBy: actor.memberId,
      })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: 'invitation.created', subjectType: 'invitation', subjectId: row!.id, actor, payload: { email, orgRole: input.orgRole } });
    return { invitation: view(row!), token };
  });
}

export async function listInvitations(db: Db, actor: Actor): Promise<InvitationView[]> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) =>
    (await tx.select().from(invitations).orderBy(desc(invitations.createdAt))).map(view),
  );
}

export async function revokeInvitation(db: Db, actor: Actor, invitationId: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt)))
      .returning();
    if (!row) throw new AppError('not_found', '邀请不存在或已被接受');
    await recordEvent(tx, { orgId: actor.orgId, type: 'invitation.revoked', subjectType: 'invitation', subjectId: invitationId, actor });
  });
}

export type InvitationPreview = {
  orgName: string;
  orgSlug: string;
  email: string;
  status: 'pending' | 'expired' | 'accepted' | 'revoked';
  accountExists: boolean;
};

/** 跨组织查询：未登录用户凭邀请链接查看邀请。 */
export function previewInvitation(db: Db, token: string): Promise<InvitationPreview | null> {
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ inv: invitations, org: organizations })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.orgId))
      .where(eq(invitations.tokenHash, sha256(token)));
    if (!row) return null;
    const [acc] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, row.inv.email));
    return {
      orgName: row.org.name,
      orgSlug: row.org.slug,
      email: row.inv.email,
      status: statusOf(row.inv),
      accountExists: Boolean(acc),
    };
  });
}

/** 跨组织查询：接受邀请时组织尚未确定，先在系统范围内定位邀请，再切换到该组织上下文写入。 */
export function acceptInvitation(
  db: Db,
  token: string,
  who: { accountId: string } | { newAccount: { name: string; password: string } },
): Promise<{ accountId: string; orgSlug: string; memberId: string }> {
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ inv: invitations, org: organizations })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.orgId))
      .where(eq(invitations.tokenHash, sha256(token)));
    if (!row) throw new AppError('not_found', '邀请不存在');
    const { inv, org } = row;
    const status = statusOf(inv);
    if (status !== 'pending') {
      throw new AppError('invalid', { accepted: '邀请已被接受', revoked: '邀请已被撤销', expired: '邀请已过期' }[status]);
    }

    let accountId: string;
    let accountName: string;
    if ('accountId' in who) {
      const [acc] = await tx.select().from(accounts).where(eq(accounts.id, who.accountId));
      if (!acc) throw new AppError('not_found', '账号不存在');
      if (acc.email !== inv.email) throw new AppError('forbidden', '该邀请发给了另一个邮箱');
      accountId = acc.id;
      accountName = acc.name;
    } else {
      const [exists] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, inv.email));
      if (exists) throw new AppError('conflict', '该邮箱已注册，请先登录再接受邀请');
      const acc = await createAccount(tx, { email: inv.email, ...who.newAccount });
      accountId = acc.id;
      accountName = acc.name;
    }

    await setOrgContext(tx, inv.orgId);
    const [dup] = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.orgId, inv.orgId), eq(members.accountId, accountId)));
    if (dup) throw new AppError('conflict', '你已经是该组织的成员');

    let memberId: string;
    if (inv.memberId) {
      await tx.update(members).set({ accountId, orgRole: inv.orgRole, email: inv.email }).where(eq(members.id, inv.memberId));
      memberId = inv.memberId;
    } else {
      const [m] = await tx
        .insert(members)
        .values({ orgId: inv.orgId, accountId, displayName: accountName, email: inv.email, orgRole: inv.orgRole })
        .returning();
      memberId = m!.id;
    }
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
    const actor: Actor = { accountId, memberId, orgId: inv.orgId, orgRole: inv.orgRole, tokenId: null, tokenScope: null };
    await recordEvent(tx, { orgId: inv.orgId, type: 'member.joined', subjectType: 'member', subjectId: memberId, actor, payload: { invitationId: inv.id } });
    return { accountId, orgSlug: org.slug, memberId };
  });
}
```

在 `src/index.ts` 追加 `export * from './tenancy/invitations';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test invitations`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 邀请与接受邀请"
```

---

### Task 12: API Token

**Files:**
- Create: `packages/core/src/access/tokens.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/tokens.test.ts`

**Interfaces:**
- Consumes: `withOrg`、`withSystem`、`isOrgAdmin`、`requireOrgAdmin`、`recordEvent`、`randomToken`、`sha256`、`safeEqualHex`、`seedInstance`、`createAgentMember`、`createProduct`
- Produces:
  - `tokenScopeSchema`（zod）
  - `type TokenView = { id: string; name: string; prefix: string; memberId: string; scope: TokenScope; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date }`
  - `issueToken(db: Db, actor: Actor, input: { memberId: string; name: string; scope: TokenScope; expiresAt?: Date | null }): Promise<{ token: string; record: TokenView }>`
  - `listTokens(db: Db, actor: Actor): Promise<TokenView[]>`
  - `revokeToken(db: Db, actor: Actor, tokenId: string): Promise<void>`
  - `authenticateToken(db: Db, raw: string): Promise<{ actor: Actor; orgSlug: string } | null>`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/tokens.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateToken, issueToken, listTokens, revokeToken } from '../src/access/tokens';
import type { Actor } from '../src/domain-types';
import { createAgentMember, createPlaceholderMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('API Token', () => {
  it('个人 Token：明文只返回一次，可认证为本人', async () => {
    const { token, record } = await issueToken(t.db, owner, {
      memberId: owner.memberId, name: '本地脚本', scope: { products: 'all', access: 'write' },
    });
    expect(token).toMatch(/^flw_[0-9a-f]{10}_[A-Za-z0-9_-]{43}$/);
    expect(record.prefix).toBe(token.slice(4, 14));
    const auth = await authenticateToken(t.db, token);
    expect(auth).toMatchObject({ orgSlug: 'acme', actor: { memberId: owner.memberId, orgRole: 'owner', tokenId: record.id } });
    expect((await listTokens(t.db, owner)).find((x) => x.id === record.id)?.lastUsedAt).toBeTruthy();
  });

  it('Agent Token：由管理员签发，范围限定到指定产品且只读', async () => {
    const agent = await createAgentMember(t.db, owner, { displayName: 'PRD 助手' });
    const { token } = await issueToken(t.db, owner, {
      memberId: agent.id, name: 'Claude Code', scope: { products: [productId], access: 'read' },
    });
    const auth = await authenticateToken(t.db, token);
    expect(auth?.actor).toMatchObject({ memberId: agent.id, accountId: null, tokenScope: { products: [productId], access: 'read' } });
  });

  it('不能给非 Agent 的其他成员签发；Token 不能再签发 Token', async () => {
    const human = await createPlaceholderMember(t.db, owner, { displayName: '张三' });
    await expect(
      issueToken(t.db, owner, { memberId: human.id, name: 'x', scope: { products: 'all', access: 'read' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const viaToken: Actor = { ...owner, tokenId: 'some-token', tokenScope: { products: 'all', access: 'write' } };
    await expect(
      issueToken(t.db, viaToken, { memberId: owner.memberId, name: 'x', scope: { products: 'all', access: 'read' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('范围里的产品必须存在', async () => {
    await expect(
      issueToken(t.db, owner, { memberId: owner.memberId, name: 'x', scope: { products: ['00000000-0000-7000-8000-000000000000'], access: 'read' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('撤销、过期、格式错误的 Token 无法认证', async () => {
    const a = await issueToken(t.db, owner, { memberId: owner.memberId, name: '将撤销', scope: { products: 'all', access: 'read' } });
    await revokeToken(t.db, owner, a.record.id);
    expect(await authenticateToken(t.db, a.token)).toBeNull();

    const b = await issueToken(t.db, owner, {
      memberId: owner.memberId, name: '已过期', scope: { products: 'all', access: 'read' }, expiresAt: new Date(Date.now() - 1000),
    });
    expect(await authenticateToken(t.db, b.token)).toBeNull();

    expect(await authenticateToken(t.db, 'flw_bad')).toBeNull();
    const tampered = `${a.token.slice(0, -1)}${a.token.endsWith('A') ? 'B' : 'A'}`;
    expect(await authenticateToken(t.db, tampered)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test tokens`
Expected: FAIL，无法解析 `../src/access/tokens`。

- [ ] **Step 3: 实现**

`packages/core/src/access/tokens.ts`：

```ts
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { randomToken, safeEqualHex, sha256 } from '../crypto';
import type { Db } from '../db/client';
import { apiTokens, members, organizations, products } from '../db/schema';
import { withOrg, withSystem } from '../db/tx';
import type { Actor, TokenScope } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { isOrgAdmin, requireOrgAdmin } from './permissions';

export const tokenScopeSchema = z.object({
  products: z.union([z.literal('all'), z.array(z.string().uuid()).min(1)]),
  access: z.enum(['read', 'write']),
});

export type TokenView = {
  id: string;
  name: string;
  prefix: string;
  memberId: string;
  scope: TokenScope;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const TOKEN_RE = /^flw_([0-9a-f]{10})_[A-Za-z0-9_-]{43}$/;

const view = (r: typeof apiTokens.$inferSelect): TokenView => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  memberId: r.memberId,
  scope: r.scope,
  expiresAt: r.expiresAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  createdAt: r.createdAt,
});

export async function issueToken(
  db: Db,
  actor: Actor,
  input: { memberId: string; name: string; scope: TokenScope; expiresAt?: Date | null },
): Promise<{ token: string; record: TokenView }> {
  if (actor.tokenId) throw new AppError('forbidden', '不能用 API Token 签发新的 Token');
  const scope = tokenScopeSchema.safeParse(input.scope);
  if (!scope.success) throw new AppError('invalid', 'Token 范围格式不正确');
  const name = input.name.trim();
  if (!name || name.length > 50) throw new AppError('invalid', 'Token 名称不能为空，且不超过 50 个字符');

  return withOrg(db, actor.orgId, async (tx) => {
    const [target] = await tx.select().from(members).where(eq(members.id, input.memberId));
    if (!target || target.status !== 'active') throw new AppError('not_found', '成员不存在');
    if (target.id !== actor.memberId) {
      if (target.kind !== 'agent') throw new AppError('forbidden', '只能为自己或 Agent 成员签发 Token');
      requireOrgAdmin(actor);
    }
    if (scope.data.products !== 'all') {
      const found = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(inArray(products.id, scope.data.products), isNull(products.deletedAt)));
      if (found.length !== scope.data.products.length) throw new AppError('invalid', 'Token 范围包含不存在的产品');
    }
    const prefix = randomBytes(5).toString('hex');
    const token = `flw_${prefix}_${randomToken(32)}`;
    const [row] = await tx
      .insert(apiTokens)
      .values({
        orgId: actor.orgId,
        memberId: target.id,
        issuedBy: actor.memberId,
        name,
        prefix,
        tokenHash: sha256(token),
        scope: scope.data,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'api_token.issued',
      subjectType: 'api_token',
      subjectId: row!.id,
      actor,
      payload: { memberId: target.id, name, scope: scope.data },
    });
    return { token, record: view(row!) };
  });
}

export async function listTokens(db: Db, actor: Actor): Promise<TokenView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(apiTokens)
      .where(isOrgAdmin(actor) ? undefined : eq(apiTokens.memberId, actor.memberId))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(view);
  });
}

export async function revokeToken(db: Db, actor: Actor, tokenId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    if (!row) throw new AppError('not_found', 'Token 不存在');
    if (row.memberId !== actor.memberId) requireOrgAdmin(actor);
    await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
    await recordEvent(tx, { orgId: actor.orgId, type: 'api_token.revoked', subjectType: 'api_token', subjectId: tokenId, actor });
  });
}

/** 跨组织查询：Token 自带组织归属，认证时尚不知道组织。 */
export function authenticateToken(db: Db, raw: string): Promise<{ actor: Actor; orgSlug: string } | null> {
  const m = TOKEN_RE.exec(raw);
  if (!m) return Promise.resolve(null);
  const prefix = m[1]!;
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ token: apiTokens, member: members, org: organizations })
      .from(apiTokens)
      .innerJoin(members, eq(members.id, apiTokens.memberId))
      .innerJoin(organizations, eq(organizations.id, apiTokens.orgId))
      .where(eq(apiTokens.prefix, prefix));
    if (!row) return null;
    const { token, member, org } = row;
    if (!safeEqualHex(token.tokenHash, sha256(raw))) return null;
    if (token.revokedAt || (token.expiresAt && token.expiresAt.getTime() <= Date.now())) return null;
    if (member.status !== 'active' || org.deletedAt) return null;
    await tx.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, token.id));
    return {
      orgSlug: org.slug,
      actor: {
        accountId: member.accountId,
        memberId: member.id,
        orgId: org.id,
        orgRole: member.orgRole,
        tokenId: token.id,
        tokenScope: token.scope,
      },
    };
  });
}
```

在 `src/index.ts` 追加 `export * from './access/tokens';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test tokens`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): API Token 签发、撤销与认证"
```

---

### Task 13: 流程定义服务

**Files:**
- Create: `packages/core/src/definitions/workflows.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/workflows.test.ts`

**Interfaces:**
- Consumes: `validateWorkflowBody`、`WorkflowBody`、`withOrg`、`requireOrgAdmin`、`requireProductRole`、`recordEvent`、`fieldDefinitions`、`seedInstance`、`createProduct`
- Produces:
  - `type WorkflowDefinitionView = { id: string; name: string; productId: string | null; currentVersionId: string | null; currentVersion: number | null; forkedFromVersionId: string | null; archivedAt: Date | null }`
  - `type WorkflowVersionView = { id: string; definitionId: string; version: number; body: WorkflowBody; note: string | null; createdAt: Date }`
  - `listWorkflowTemplates(db: Db, actor: Actor): Promise<WorkflowDefinitionView[]>`
  - `getWorkflowDefinition(db: Db, actor: Actor, definitionId: string): Promise<{ definition: WorkflowDefinitionView; versions: WorkflowVersionView[] }>`
  - `createWorkflowTemplate(db: Db, actor: Actor, input: { name: string; body: unknown; note?: string }): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }>`
  - `publishWorkflowVersion(db: Db, actor: Actor, definitionId: string, input: { body: unknown; note?: string }): Promise<WorkflowVersionView>`
  - `forkWorkflowForProduct(db: Db, actor: Actor, productId: string, input: { fromVersionId: string }): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }>`
  - `setProductWorkflowVersion(db: Db, actor: Actor, productId: string, versionId: string): Promise<void>`
  - `getProductWorkflow(db: Db, actor: Actor, productId: string): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }>`
  - 流程校验失败时抛 `AppError('invalid', '流程定义有误', issues: ValidationIssue[])`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/workflows.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_BODY } from '../src/definitions/defaults';
import {
  createWorkflowTemplate,
  forkWorkflowForProduct,
  getProductWorkflow,
  getWorkflowDefinition,
  listWorkflowTemplates,
  publishWorkflowVersion,
  setProductWorkflowVersion,
} from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { AppError } from '../src/errors';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

const withReview = {
  ...DEFAULT_WORKFLOW_BODY,
  checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
  transitions: [
    { from: 'backlog', to: 'todo', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] },
    { from: '*', to: 'canceled', conditions: [] },
  ],
};

describe('流程定义', () => {
  it('组织有一份默认模板，产品默认使用它', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    expect(templates.map((x) => x.name)).toEqual(['默认流程']);
    const pw = await getProductWorkflow(t.db, owner, productId);
    expect(pw.definition.id).toBe(templates[0]!.id);
    expect(pw.version.body.initial).toBe('backlog');
  });

  it('创建模板并发布新版本，旧版本保持不变', async () => {
    const { definition, version } = await createWorkflowTemplate(t.db, owner, { name: '网盘流程', body: DEFAULT_WORKFLOW_BODY });
    expect(version.version).toBe(1);
    const v2 = await publishWorkflowVersion(t.db, owner, definition.id, { body: withReview, note: '加可行性评估' });
    expect(v2.version).toBe(2);
    const { definition: d, versions } = await getWorkflowDefinition(t.db, owner, definition.id);
    expect(d.currentVersion).toBe(2);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]!.body.checkItems).toEqual([]);
  });

  it('非法定义返回 invalid 与问题清单', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    const err = await publishWorkflowVersion(t.db, owner, templates[0]!.id, {
      body: { ...DEFAULT_WORKFLOW_BODY, initial: 'ghost' },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('invalid');
    expect(err.details).toEqual([{ path: 'initial', message: '初始状态「ghost」不存在' }]);
  });

  it('条件可以引用组织字段', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    const v = await publishWorkflowVersion(t.db, owner, templates[0]!.id, {
      body: {
        ...DEFAULT_WORKFLOW_BODY,
        transitions: [{ from: 'backlog', to: 'todo', conditions: [{ type: 'field_set', field: 'priority' }] }],
      },
    });
    expect(v.version).toBe(2);
  });

  it('产品从模板复制一份覆盖，并切换到覆盖版本', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    const { definition, version } = await forkWorkflowForProduct(t.db, owner, productId, {
      fromVersionId: templates[0]!.currentVersionId!,
    });
    expect(definition.productId).toBe(productId);
    expect(definition.forkedFromVersionId).toBe(templates[0]!.currentVersionId);
    expect((await getProductWorkflow(t.db, owner, productId)).version.id).toBe(version.id);
    expect((await listWorkflowTemplates(t.db, owner)).some((d) => d.id === definition.id)).toBe(false);
  });

  it('产品只能切换到模板版本或自己的覆盖版本', async () => {
    const other = await createProduct(t.db, owner, { name: '会员', key: 'VIP' });
    const otherFork = await forkWorkflowForProduct(t.db, owner, other.id, {
      fromVersionId: (await listWorkflowTemplates(t.db, owner))[0]!.currentVersionId!,
    });
    await expect(setProductWorkflowVersion(t.db, owner, productId, otherFork.version.id)).rejects.toMatchObject({ code: 'invalid' });
    const tpl = (await listWorkflowTemplates(t.db, owner))[0]!;
    await setProductWorkflowVersion(t.db, owner, productId, tpl.currentVersionId!);
    expect((await getProductWorkflow(t.db, owner, productId)).version.id).toBe(tpl.currentVersionId);
  });

  it('普通成员不能管理模板', async () => {
    await expect(createWorkflowTemplate(t.db, { ...owner, orgRole: 'member' }, { name: 'x', body: DEFAULT_WORKFLOW_BODY })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test workflows`
Expected: FAIL，无法解析 `../src/definitions/workflows`。

- [ ] **Step 3: 实现**

`packages/core/src/definitions/workflows.ts`：

```ts
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { fieldDefinitions, products, workflowDefinitions, workflowVersions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { validateWorkflowBody, type WorkflowBody } from './workflow-schema';

export type WorkflowDefinitionView = {
  id: string;
  name: string;
  productId: string | null;
  currentVersionId: string | null;
  currentVersion: number | null;
  forkedFromVersionId: string | null;
  archivedAt: Date | null;
};

export type WorkflowVersionView = {
  id: string;
  definitionId: string;
  version: number;
  body: WorkflowBody;
  note: string | null;
  createdAt: Date;
};

type DefRow = typeof workflowDefinitions.$inferSelect;
type VerRow = typeof workflowVersions.$inferSelect;

const versionView = (v: VerRow): WorkflowVersionView => ({
  id: v.id,
  definitionId: v.definitionId,
  version: v.version,
  body: v.body as WorkflowBody,
  note: v.note,
  createdAt: v.createdAt,
});

async function definitionView(tx: Tx, d: DefRow): Promise<WorkflowDefinitionView> {
  let currentVersion: number | null = null;
  if (d.currentVersionId) {
    const [v] = await tx.select({ version: workflowVersions.version }).from(workflowVersions).where(eq(workflowVersions.id, d.currentVersionId));
    currentVersion = v?.version ?? null;
  }
  return {
    id: d.id,
    name: d.name,
    productId: d.productId,
    currentVersionId: d.currentVersionId,
    currentVersion,
    forkedFromVersionId: d.forkedFromVersionId,
    archivedAt: d.archivedAt,
  };
}

/** 流程条件可引用的字段：组织字段，加上产品覆盖字段。 */
async function fieldKeysFor(tx: Tx, productId: string | null): Promise<string[]> {
  const rows = await tx
    .select({ key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(productId ? or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, productId)) : isNull(fieldDefinitions.productId));
  return [...new Set(rows.map((r) => r.key))];
}

async function validateOrThrow(tx: Tx, body: unknown, productId: string | null): Promise<WorkflowBody> {
  const r = validateWorkflowBody(body, { fieldKeys: await fieldKeysFor(tx, productId) });
  if (!r.ok) throw new AppError('invalid', '流程定义有误', r.issues);
  return r.body;
}

async function loadDefinition(tx: Tx, id: string): Promise<DefRow> {
  const [d] = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id));
  if (!d) throw new AppError('not_found', '流程不存在');
  return d;
}

/** 模板由组织管理员管理；产品覆盖由产品管理员管理。 */
async function requireManage(tx: Tx, actor: Actor, d: DefRow): Promise<void> {
  if (d.productId) await requireProductRole(tx, actor, d.productId, 'admin');
  else requireOrgAdmin(actor);
}

async function insertVersion(tx: Tx, actor: Actor, d: DefRow, body: WorkflowBody, note: string | null): Promise<VerRow> {
  const [last] = await tx
    .select({ version: workflowVersions.version })
    .from(workflowVersions)
    .where(eq(workflowVersions.definitionId, d.id))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  const [v] = await tx
    .insert(workflowVersions)
    .values({ orgId: actor.orgId, definitionId: d.id, version: (last?.version ?? 0) + 1, body, note, createdBy: actor.memberId })
    .returning();
  await tx.update(workflowDefinitions).set({ currentVersionId: v!.id }).where(eq(workflowDefinitions.id, d.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: d.productId,
    type: 'workflow.version_published',
    subjectType: 'workflow_definition',
    subjectId: d.id,
    actor,
    payload: { version: v!.version, note },
  });
  return v!;
}

export async function listWorkflowTemplates(db: Db, actor: Actor): Promise<WorkflowDefinitionView[]> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowDefinitions)
      .where(isNull(workflowDefinitions.productId))
      .orderBy(asc(workflowDefinitions.createdAt));
    return Promise.all(rows.map((d) => definitionView(tx, d)));
  });
}

export async function getWorkflowDefinition(
  db: Db,
  actor: Actor,
  definitionId: string,
): Promise<{ definition: WorkflowDefinitionView; versions: WorkflowVersionView[] }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const d = await loadDefinition(tx, definitionId);
    await requireManage(tx, actor, d);
    const versions = await tx
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.definitionId, d.id))
      .orderBy(desc(workflowVersions.version));
    return { definition: await definitionView(tx, d), versions: versions.map(versionView) };
  });
}

export async function createWorkflowTemplate(
  db: Db,
  actor: Actor,
  input: { name: string; body: unknown; note?: string },
): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }> {
  requireOrgAdmin(actor);
  const name = input.name.trim();
  if (!name || name.length > 30) throw new AppError('invalid', '流程名称不能为空，且不超过 30 个字符');
  return withOrg(db, actor.orgId, async (tx) => {
    const body = await validateOrThrow(tx, input.body, null);
    const [d] = await tx.insert(workflowDefinitions).values({ orgId: actor.orgId, name }).returning();
    const v = await insertVersion(tx, actor, d!, body, input.note ?? null);
    return { definition: await definitionView(tx, await loadDefinition(tx, d!.id)), version: versionView(v) };
  });
}

export async function publishWorkflowVersion(
  db: Db,
  actor: Actor,
  definitionId: string,
  input: { body: unknown; note?: string },
): Promise<WorkflowVersionView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const d = await loadDefinition(tx, definitionId);
    await requireManage(tx, actor, d);
    const body = await validateOrThrow(tx, input.body, d.productId);
    return versionView(await insertVersion(tx, actor, d, body, input.note ?? null));
  });
}

export async function forkWorkflowForProduct(
  db: Db,
  actor: Actor,
  productId: string,
  input: { fromVersionId: string },
): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [src] = await tx.select().from(workflowVersions).where(eq(workflowVersions.id, input.fromVersionId));
    if (!src) throw new AppError('not_found', '流程版本不存在');
    const srcDef = await loadDefinition(tx, src.definitionId);
    const [product] = await tx.select().from(products).where(eq(products.id, productId));
    const [d] = await tx
      .insert(workflowDefinitions)
      .values({ orgId: actor.orgId, productId, name: `${product!.name}的流程（基于${srcDef.name}）`, forkedFromVersionId: src.id })
      .returning();
    const v = await insertVersion(tx, actor, d!, src.body as WorkflowBody, `复制自「${srcDef.name}」v${src.version}`);
    await tx.update(products).set({ workflowVersionId: v.id }).where(eq(products.id, productId));
    return { definition: await definitionView(tx, await loadDefinition(tx, d!.id)), version: versionView(v) };
  });
}

export async function setProductWorkflowVersion(db: Db, actor: Actor, productId: string, versionId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [row] = await tx
      .select({ version: workflowVersions, definition: workflowDefinitions })
      .from(workflowVersions)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowVersions.definitionId))
      .where(eq(workflowVersions.id, versionId));
    if (!row) throw new AppError('not_found', '流程版本不存在');
    if (row.definition.productId !== null && row.definition.productId !== productId) {
      throw new AppError('invalid', '不能使用其他产品的流程');
    }
    const [before] = await tx.select({ v: products.workflowVersionId }).from(products).where(eq(products.id, productId));
    await tx.update(products).set({ workflowVersionId: versionId }).where(eq(products.id, productId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'product.workflow_changed',
      subjectType: 'product',
      subjectId: productId,
      actor,
      payload: { changes: [{ field: 'workflowVersionId', old: before?.v ?? null, new: versionId }] },
    });
  });
}

export async function getProductWorkflow(
  db: Db,
  actor: Actor,
  productId: string,
): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const [row] = await tx
      .select({ version: workflowVersions, definition: workflowDefinitions })
      .from(products)
      .innerJoin(workflowVersions, eq(workflowVersions.id, products.workflowVersionId))
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowVersions.definitionId))
      .where(and(eq(products.id, productId)));
    if (!row) throw new AppError('not_found', '该产品尚未指定流程');
    return { definition: await definitionView(tx, row.definition), version: versionView(row.version) };
  });
}
```

在 `src/index.ts` 追加 `export * from './definitions/workflows';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test workflows`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 流程模板、版本发布与产品覆盖"
```

---

### Task 14: 字段字典与结构树层级叫法

**Files:**
- Create: `packages/core/src/definitions/fields.ts`, `packages/core/src/definitions/levels.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/fields.test.ts`

**Interfaces:**
- Consumes: `withOrg`、`requireOrgAdmin`、`requireNonGuest`、`requireProductRole`、`recordEvent`、`randomToken`、`DEFAULT_LEVEL_NAMES`、`seedInstance`、`createProduct`
- Produces:
  - `type FieldOptionView = { id: string; key: string; label: string; color: string | null; sort: number; active: boolean }`
  - `type FieldView = { id: string; key: string; label: string; cardinality: 'single' | 'multi'; builtin: boolean; productId: string | null; options: FieldOptionView[] }`
  - `listFields(db: Db, actor: Actor, opts?: { productId?: string }): Promise<FieldView[]>`（指定产品时返回合并后的有效字段）
  - `addFieldOption(db: Db, actor: Actor, fieldId: string, input: { label: string; color?: string | null; key?: string }): Promise<FieldOptionView>`
  - `updateFieldOption(db: Db, actor: Actor, optionId: string, input: { label?: string; color?: string | null; active?: boolean }): Promise<FieldOptionView>`
  - `reorderFieldOptions(db: Db, actor: Actor, fieldId: string, optionIds: string[]): Promise<FieldOptionView[]>`
  - `forkFieldForProduct(db: Db, actor: Actor, productId: string, orgFieldId: string): Promise<FieldView>`
  - `validateLevelNames(names: unknown): string[]`
  - `getLevelNames(db: Db, actor: Actor, productId?: string): Promise<{ names: string[]; source: 'default' | 'org' | 'product' }>`
  - `setOrgLevelNames(db: Db, actor: Actor, names: string[]): Promise<string[]>`
  - `setProductLevelNames(db: Db, actor: Actor, productId: string, names: string[] | null): Promise<void>`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/fields.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFieldOption, forkFieldForProduct, listFields, reorderFieldOptions, updateFieldOption } from '../src/definitions/fields';
import { getLevelNames, setOrgLevelNames, setProductLevelNames } from '../src/definitions/levels';
import type { Actor } from '../src/domain-types';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

const field = async (key: string, productId?: string) =>
  (await listFields(t.db, owner, { productId })).find((f) => f.key === key)!;

describe('字段字典', () => {
  it('增加选项、改名、停用、排序', async () => {
    const platform = await field('platform');
    const pc = await addFieldOption(t.db, owner, platform.id, { label: 'PC客户端', color: '#2563eb' });
    const web = await addFieldOption(t.db, owner, platform.id, { label: 'Web端' });
    expect(pc.key).toMatch(/^o_/);
    await updateFieldOption(t.db, owner, web.id, { label: '网页端', active: false });
    await reorderFieldOptions(t.db, owner, platform.id, [web.id, pc.id]);
    const after = await field('platform');
    expect(after.options.map((o) => [o.label, o.active])).toEqual([['网页端', false], ['PC客户端', true]]);
  });

  it('排序必须包含该字段的全部选项', async () => {
    const platform = await field('platform');
    await expect(reorderFieldOptions(t.db, owner, platform.id, [platform.options[0]!.id])).rejects.toMatchObject({ code: 'invalid' });
  });

  it('产品覆盖字段后，产品视图使用覆盖版本，组织视图不变', async () => {
    const org = await field('priority');
    const forked = await forkFieldForProduct(t.db, owner, productId, org.id);
    expect(forked.productId).toBe(productId);
    expect(forked.options.map((o) => o.key)).toEqual(['p0', 'p1', 'p2', 'p3']);
    await addFieldOption(t.db, owner, forked.id, { label: '绿色通道', key: 'green' });

    expect((await field('priority', productId)).options.map((o) => o.label)).toContain('绿色通道');
    expect((await field('priority')).options.map((o) => o.label)).not.toContain('绿色通道');
    await expect(forkFieldForProduct(t.db, owner, productId, org.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('普通成员不能改组织字典', async () => {
    const platform = await field('platform');
    await expect(addFieldOption(t.db, { ...owner, orgRole: 'member' }, platform.id, { label: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('结构树层级叫法', () => {
  it('默认值、组织设置、产品覆盖与清除', async () => {
    expect(await getLevelNames(t.db, owner)).toEqual({ names: ['业务域', '模块', '功能点'], source: 'org' });
    await setOrgLevelNames(t.db, owner, ['产品线', '能力']);
    expect(await getLevelNames(t.db, owner, productId)).toEqual({ names: ['产品线', '能力'], source: 'org' });
    await setProductLevelNames(t.db, owner, productId, ['模块']);
    expect(await getLevelNames(t.db, owner, productId)).toEqual({ names: ['模块'], source: 'product' });
    await setProductLevelNames(t.db, owner, productId, null);
    expect((await getLevelNames(t.db, owner, productId)).source).toBe('org');
  });

  it('层级数量与名称长度校验', async () => {
    await expect(setOrgLevelNames(t.db, owner, [])).rejects.toMatchObject({ code: 'invalid' });
    await expect(setOrgLevelNames(t.db, owner, ['a', 'b', 'c', 'd'])).rejects.toMatchObject({ code: 'invalid' });
    await expect(setOrgLevelNames(t.db, owner, ['这是一个超过十个字的层级名称'])).rejects.toMatchObject({ code: 'invalid' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test fields`
Expected: FAIL，无法解析 `../src/definitions/fields`。

- [ ] **Step 3: 实现字段字典**

`packages/core/src/definitions/fields.ts`：

```ts
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
    const [row] = await tx
      .update(fieldOptions)
      .set({
        ...(input.label === undefined ? {} : { label: assertLabel(input.label) }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.active === undefined ? {} : { active: input.active }),
      })
      .where(eq(fieldOptions.id, optionId))
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, productId: f.productId, type: 'field.option_updated', subjectType: 'field', subjectId: f.id, actor, payload: { optionId, ...input } });
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
```

- [ ] **Step 4: 实现层级叫法**

`packages/core/src/definitions/levels.ts`：

```ts
import { eq } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { organizations, products } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { DEFAULT_LEVEL_NAMES } from './defaults';

export function validateLevelNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length < 1 || names.length > 3) {
    throw new AppError('invalid', '层级数量为 1–3 层');
  }
  return names.map((n) => {
    const s = typeof n === 'string' ? n.trim() : '';
    if (!s || s.length > 10) throw new AppError('invalid', '每层名称不能为空，且不超过 10 个字符');
    return s;
  });
}

export async function getLevelNames(
  db: Db,
  actor: Actor,
  productId?: string,
): Promise<{ names: string[]; source: 'default' | 'org' | 'product' }> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (productId) {
      await requireProductRole(tx, actor, productId, 'viewer');
      const [p] = await tx.select({ names: products.structureLevelNames }).from(products).where(eq(products.id, productId));
      if (p?.names) return { names: p.names, source: 'product' };
    } else {
      requireNonGuest(actor);
    }
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId));
    const names = org?.settings.structureLevelNames;
    return names ? { names, source: 'org' } : { names: DEFAULT_LEVEL_NAMES, source: 'default' };
  });
}

export async function setOrgLevelNames(db: Db, actor: Actor, names: string[]): Promise<string[]> {
  requireOrgAdmin(actor);
  const clean = validateLevelNames(names);
  return withOrg(db, actor.orgId, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.orgId));
    await tx
      .update(organizations)
      .set({ settings: { ...org!.settings, structureLevelNames: clean } })
      .where(eq(organizations.id, actor.orgId));
    await recordEvent(tx, {
      orgId: actor.orgId, type: 'organization.level_names_set', subjectType: 'organization', subjectId: actor.orgId, actor,
      payload: { changes: [{ field: 'structureLevelNames', old: org!.settings.structureLevelNames ?? null, new: clean }] },
    });
    return clean;
  });
}

export async function setProductLevelNames(db: Db, actor: Actor, productId: string, names: string[] | null): Promise<void> {
  const clean = names === null ? null : validateLevelNames(names);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    await tx.update(products).set({ structureLevelNames: clean }).where(eq(products.id, productId));
    await recordEvent(tx, {
      orgId: actor.orgId, productId, type: 'product.level_names_set', subjectType: 'product', subjectId: productId, actor,
      payload: { names: clean },
    });
  });
}
```

在 `src/index.ts` 追加：

```ts
export * from './definitions/fields';
export * from './definitions/levels';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core test`
Expected: 全部 core 测试 PASS（字段相关 6 个用例），`pnpm --filter @flower/core typecheck` 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/core
git commit -m "feat(core): 字段字典与结构树层级叫法"
```

---

### Task 15: Web 应用宿主与 API 骨架（初始化、登录、个人、实例设置）

**Files:**
- Create: `apps/web/`（`create-next-app` 生成）
- Modify: `apps/web/package.json`, `apps/web/next.config.ts`
- Create: `apps/web/vitest.config.ts`, `apps/web/src/instrumentation.ts`, `apps/web/src/app/api/v1/[[...route]]/route.ts`
- Create: `apps/web/src/server/runtime.ts`, `src/server/api.ts`, `src/server/http.ts`, `src/server/auth-middleware.ts`
- Create: `apps/web/src/server/routes/setup.ts`, `routes/auth.ts`, `routes/instance.ts`
- Create: `apps/web/test/api/helpers.ts`
- Test: `apps/web/test/api/auth.test.ts`

**Interfaces:**
- Consumes: `@flower/core` 的 `getInstanceStatus`、`initializeInstance`、`signUp`、`updateInstanceSettings`、`login`、`createSession`、`resolveSession`、`revokeSession`、`updateProfile`、`changePassword`、`listMyOrganizations`、`authenticateToken`、`resolveActor`、`AppError`、`SESSION_COOKIE`
- Produces:
  - `type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string }`
  - `type ApiEnv`、`type App = Hono<ApiEnv>`、`createApi(deps: ApiDeps): App`
  - `readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>>`、`setSessionCookie(c, token, expiresAt, secure)`、`clearSessionCookie(c)`、`sessionMeta(c)`
  - `requireAccount(c): AccountView`、`orgActor(deps)` 中间件（设置 `c.var.actor`）
  - HTTP：`GET /api/v1/setup/status`、`POST /api/v1/setup`、`POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`POST /api/v1/auth/register`、`GET /api/v1/me`、`PATCH /api/v1/me`、`POST /api/v1/me/password`、`GET|PATCH /api/v1/instance/settings`
  - 错误响应统一为 `{ error: { code, message, details } }`，状态码：invalid 400、unauthenticated 401、forbidden 403、not_found 404、conflict / already_initialized 409
  - 测试工具：`makeApp()`、`call(app, method, path, opts)`、`sessionFrom(res)`、`initAndLogin(app)`

- [ ] **Step 1: 生成 Next 应用并接入 workspace**

```bash
pnpm create next-app@latest apps/web --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --yes
```

把 `apps/web/package.json` 的 `name` 改为 `@flower/web`，在 `scripts` 中加入：

```json
"test": "vitest run",
"typecheck": "tsc --noEmit"
```

安装依赖：

```bash
pnpm --filter @flower/web add hono zod "@flower/core@workspace:*"
pnpm --filter @flower/web add -D vitest
```

`apps/web/next.config.ts`：

```ts
import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  transpilePackages: ['@flower/core'],
  serverExternalPackages: ['@node-rs/argon2'],
};

export default nextConfig;
```

`apps/web/vitest.config.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../packages/core/test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **Step 2: 写测试工具与失败的测试**

`apps/web/test/api/helpers.ts`：

```ts
import { createTestDb } from '@flower/core/testing';
import { type App, createApi } from '@/server/api';

export async function makeApp(): Promise<{ app: App; cleanup: () => Promise<void> }> {
  const t = await createTestDb();
  const app = createApi({ db: t.db, secureCookies: false, publicUrl: 'http://localhost:3000' });
  return { app, cleanup: t.cleanup };
}

export function sessionFrom(res: Response): string {
  const m = /flower_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('响应中没有会话 cookie');
  return m[1]!;
}

export async function call(
  app: App,
  method: string,
  path: string,
  opts: { session?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.session) headers.cookie = `flower_session=${opts.session}`;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.clone().text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

export async function initAndLogin(app: App): Promise<string> {
  const r = await call(app, 'POST', '/setup', {
    body: {
      admin: { email: 'owner@example.com', name: 'Owner', password: 'password123' },
      org: { name: '测试组织', slug: 'acme' },
    },
  });
  if (r.status !== 201) throw new Error(`初始化失败：${JSON.stringify(r.body)}`);
  return sessionFrom(r.res);
}
```

`apps/web/test/api/auth.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
});
afterAll(() => cleanup());

describe('初始化与登录', () => {
  it('初始化前状态', async () => {
    const r = await call(app, 'GET', '/setup/status');
    expect(r.body).toEqual({ initialized: false, allowSignup: false, allowOrgCreation: false });
  });

  it('参数错误返回 400 与明细', async () => {
    const r = await call(app, 'POST', '/setup', { body: { admin: {} } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid');
    expect(Array.isArray(r.body.error.details)).toBe(true);
  });

  it('初始化后自动登录，/me 返回账号与组织', async () => {
    session = await initAndLogin(app);
    const me = await call(app, 'GET', '/me', { session });
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ email: 'owner@example.com', isInstanceAdmin: true });
    expect(me.body.orgs.map((o: { slug: string }) => o.slug)).toEqual(['acme']);
  });

  it('不能重复初始化', async () => {
    const r = await call(app, 'POST', '/setup', {
      body: { admin: { email: 'x@example.com', name: 'X', password: 'password123' }, org: { name: 'X', slug: 'x' } },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('already_initialized');
  });

  it('登录、注销', async () => {
    const bad = await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'wrong-password' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('邮箱或密码错误');

    const ok = await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'password123' } });
    expect(ok.status).toBe(200);
    const s = sessionFrom(ok.res);
    expect((await call(app, 'POST', '/auth/logout', { session: s })).status).toBe(204);
    expect((await call(app, 'GET', '/me', { session: s })).status).toBe(401);
  });

  it('修改资料与密码', async () => {
    const p = await call(app, 'PATCH', '/me', { session, body: { name: '主人', preferences: { theme: 'light' } } });
    expect(p.body.account).toMatchObject({ name: '主人', preferences: { theme: 'light' } });
    const pw = await call(app, 'POST', '/me/password', { session, body: { currentPassword: 'password123', newPassword: 'password456' } });
    expect(pw.status).toBe(204);
  });

  it('默认邀请制；实例管理员开放注册后可注册', async () => {
    const denied = await call(app, 'POST', '/auth/register', { body: { email: 'a@example.com', name: 'A', password: 'password123' } });
    expect(denied.status).toBe(403);
    const settings = await call(app, 'PATCH', '/instance/settings', { session, body: { allowSignup: true } });
    expect(settings.body.allowSignup).toBe(true);
    const ok = await call(app, 'POST', '/auth/register', { body: { email: 'a@example.com', name: 'A', password: 'password123' } });
    expect(ok.status).toBe(201);
    const aSession = sessionFrom(ok.res);
    expect((await call(app, 'GET', '/instance/settings', { session: aSession })).status).toBe(403);
  });

  it('未知接口返回 404 JSON', async () => {
    const r = await call(app, 'GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @flower/web test`
Expected: FAIL，无法解析 `@/server/api`。

- [ ] **Step 4: 实现 API 骨架**

`apps/web/src/server/http.ts`：

```ts
import { AppError, SESSION_COOKIE } from '@flower/core';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

const STATUS = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  already_initialized: 409,
} as const;

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, STATUS[err.code]);
  }
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: { code: 'internal', message: '服务器内部错误', details: null } }, 500);
}

export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('invalid', '请求体不是合法的 JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError(
      'invalid',
      '请求参数有误',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export function setSessionCookie(c: Context, token: string, expiresAt: Date, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: expiresAt });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function sessionMeta(c: Context): { ip: string | null; userAgent: string | null } {
  return {
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}
```

`apps/web/src/server/auth-middleware.ts`：

```ts
import {
  type AccountView,
  type Actor,
  AppError,
  authenticateToken,
  resolveActor,
  resolveSession,
  SESSION_COOKIE,
} from '@flower/core';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { ApiDeps, ApiEnv } from './api';

export const authenticate = (deps: ApiDeps) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    c.set('account', null);
    c.set('tokenAuth', null);
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
      const r = await authenticateToken(deps.db, auth.slice('Bearer '.length).trim());
      if (!r) throw new AppError('unauthenticated', 'API Token 无效、已撤销或已过期');
      c.set('tokenAuth', r);
    } else {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) c.set('account', await resolveSession(deps.db, token));
    }
    await next();
  });

export function requireAccount(c: Context<ApiEnv>): AccountView {
  const account = c.get('account');
  if (!account) throw new AppError('unauthenticated', '请先登录');
  return account;
}

/** 解析 /orgs/:org 下的操作者：Token 必须属于该组织，会话用户必须是该组织成员。 */
export const orgActor = (deps: ApiDeps) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    const slug = c.req.param('org') ?? '';
    const tokenAuth = c.get('tokenAuth');
    let actor: Actor | null;
    if (tokenAuth) {
      actor = tokenAuth.orgSlug === slug ? tokenAuth.actor : null;
    } else {
      actor = await resolveActor(deps.db, requireAccount(c).id, slug);
    }
    if (!actor) throw new AppError('not_found', '组织不存在');
    c.set('actor', actor);
    await next();
  });
```

`apps/web/src/server/api.ts`（本任务注册三组路由；Task 16、17 在标注处追加）：

```ts
import type { AccountView, Actor, Db } from '@flower/core';
import { Hono } from 'hono';
import { authenticate, orgActor } from './auth-middleware';
import { errorHandler } from './http';
import { registerAuthRoutes } from './routes/auth';
import { registerInstanceRoutes } from './routes/instance';
import { registerSetupRoutes } from './routes/setup';

export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string };
export type ApiEnv = {
  Variables: {
    account: AccountView | null;
    tokenAuth: { actor: Actor; orgSlug: string } | null;
    actor: Actor;
  };
};
export type App = Hono<ApiEnv>;

export function createApi(deps: ApiDeps): App {
  const app = new Hono<ApiEnv>().basePath('/api/v1');
  app.onError(errorHandler);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: '接口不存在', details: null } }, 404));
  app.use('*', authenticate(deps));
  app.use('/orgs/:org', orgActor(deps));
  app.use('/orgs/:org/*', orgActor(deps));

  registerSetupRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerInstanceRoutes(app, deps);
  // Task 16：组织资源路由
  // Task 17：配置定义路由
  return app;
}
```

注意：`/orgs/:org` 的中间件会拦截 `GET /orgs`（列表）吗？不会，`/orgs` 不匹配 `/orgs/:org`。

`apps/web/src/server/routes/setup.ts`：

```ts
import { createSession, getInstanceStatus, initializeInstance } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson, sessionMeta, setSessionCookie } from '../http';

const setupSchema = z.object({
  admin: z.object({ email: z.string(), name: z.string(), password: z.string() }),
  org: z.object({ name: z.string(), slug: z.string() }),
});

export function registerSetupRoutes(app: App, deps: ApiDeps): void {
  app.get('/setup/status', async (c) => c.json(await getInstanceStatus(deps.db)));

  app.post('/setup', async (c) => {
    const body = await readJson(c, setupSchema);
    const r = await initializeInstance(deps.db, body);
    const s = await createSession(deps.db, r.account.id, sessionMeta(c));
    setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies);
    return c.json({ account: r.account, org: r.org }, 201);
  });
}
```

`apps/web/src/server/routes/auth.ts`：

```ts
import {
  changePassword,
  createSession,
  listMyOrganizations,
  login,
  revokeSession,
  SESSION_COOKIE,
  signUp,
  updateProfile,
} from '@flower/core';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';
import { clearSessionCookie, readJson, sessionMeta, setSessionCookie } from '../http';

export function registerAuthRoutes(app: App, deps: ApiDeps): void {
  app.post('/auth/login', async (c) => {
    const body = await readJson(c, z.object({ email: z.string(), password: z.string() }));
    const r = await login(deps.db, body, sessionMeta(c));
    setSessionCookie(c, r.token, r.expiresAt, deps.secureCookies);
    return c.json({ account: r.account });
  });

  app.post('/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSession(deps.db, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.post('/auth/register', async (c) => {
    const body = await readJson(c, z.object({ email: z.string(), name: z.string(), password: z.string() }));
    const account = await signUp(deps.db, body);
    const s = await createSession(deps.db, account.id, sessionMeta(c));
    setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies);
    return c.json({ account }, 201);
  });

  app.get('/me', async (c) => {
    const account = requireAccount(c);
    return c.json({ account, orgs: await listMyOrganizations(deps.db, account.id) });
  });

  app.patch('/me', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(
      c,
      z.object({
        name: z.string().optional(),
        preferences: z
          .object({ theme: z.enum(['light', 'dark', 'system']).optional(), locale: z.string().optional(), timezone: z.string().optional() })
          .optional(),
      }),
    );
    return c.json({ account: await updateProfile(deps.db, account.id, body) });
  });

  app.post('/me/password', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(c, z.object({ currentPassword: z.string(), newPassword: z.string() }));
    await changePassword(deps.db, account.id, body);
    return c.body(null, 204);
  });
}
```

`apps/web/src/server/routes/instance.ts`：

```ts
import { AppError, getInstanceStatus, updateInstanceSettings } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';
import { readJson } from '../http';

export function registerInstanceRoutes(app: App, deps: ApiDeps): void {
  app.get('/instance/settings', async (c) => {
    if (!requireAccount(c).isInstanceAdmin) throw new AppError('forbidden', '需要实例管理员权限');
    return c.json(await getInstanceStatus(deps.db));
  });

  app.patch('/instance/settings', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(c, z.object({ allowSignup: z.boolean().optional(), allowOrgCreation: z.boolean().optional() }));
    return c.json(await updateInstanceSettings(deps.db, account, body));
  });
}
```

`apps/web/src/server/runtime.ts`：

```ts
import { createDb, loadConfig } from '@flower/core';
import { type App, createApi } from './api';

let api: App | undefined;

export function getApi(): App {
  if (!api) {
    const config = loadConfig();
    const { db } = createDb(config.databaseUrl);
    api = createApi({ db, secureCookies: config.publicUrl.startsWith('https://'), publicUrl: config.publicUrl });
  }
  return api;
}
```

`apps/web/src/app/api/v1/[[...route]]/route.ts`：

```ts
import { handle } from 'hono/vercel';
import { getApi } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handler(req: Request) {
  return handle(getApi())(req);
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT };
```

`apps/web/src/instrumentation.ts`（服务启动时校验配置，缺少环境变量直接启动失败）：

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadConfig } = await import('@flower/core');
    loadConfig();
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web test && pnpm --filter @flower/web typecheck`
Expected: PASS（`auth.test.ts` 8 个用例），typecheck 无错误。

- [ ] **Step 6: 本地手动验证**

```bash
cp .env.example apps/web/.env.local
# 编辑 apps/web/.env.local，填入 FLOWER_SECRET_KEY=$(openssl rand -base64 48) 的结果
```

在 `packages/core/package.json` 的 `scripts` 中加入：

```json
"db:migrate": "pnpm build:migrate && node --env-file=../../apps/web/.env.local dist/migrate.mjs"
```

在根 `package.json` 的 `scripts` 中加入：

```json
"db:migrate": "pnpm --filter @flower/core db:migrate"
```

```bash
pnpm db:up && pnpm db:migrate && pnpm dev
curl -s http://localhost:3000/api/v1/setup/status
```

Expected: 输出 `{"initialized":false,"allowSignup":false,"allowOrgCreation":false}`。再把 `.env.local` 里的 `FLOWER_SECRET_KEY` 清空重启 `pnpm dev`，Expected：启动失败并打印"缺少环境变量：FLOWER_SECRET_KEY"。验证后恢复密钥。

- [ ] **Step 7: 提交**

```bash
git add apps/web packages/core/package.json package.json pnpm-lock.yaml
git commit -m "feat(web): Next 宿主与 API 骨架：初始化、登录、个人与实例设置"
```

---

### Task 16: 组织资源 API（组织、成员、Agent、职能标签、邀请、Token、产品）

**Files:**
- Create: `apps/web/src/server/routes/orgs.ts`, `routes/members.ts`, `routes/invitations.ts`, `routes/tokens.ts`, `routes/products.ts`
- Modify: `apps/web/src/server/api.ts`
- Test: `apps/web/test/api/orgs.test.ts`

**Interfaces:**
- Consumes: Task 7–12 的全部服务函数；Task 15 的 `readJson`、`requireAccount`、`setSessionCookie`、`sessionMeta`
- Produces（HTTP）：
  - `GET /orgs`、`POST /orgs`、`GET /orgs/:org`（返回 `{ org, me: { memberId, orgRole } }`）、`PATCH /orgs/:org`
  - `GET|POST /orgs/:org/members`、`PATCH /orgs/:org/members/:id`、`PUT /orgs/:org/members/:id/function-tags`
  - `POST /orgs/:org/agents`
  - `GET|POST /orgs/:org/function-tags`、`PATCH|DELETE /orgs/:org/function-tags/:id`
  - `GET|POST /orgs/:org/invitations`（创建时返回 `{ invitation, token, link }`）、`DELETE /orgs/:org/invitations/:id`
  - `GET /invitations/:token`、`POST /invitations/:token/accept`（已登录用当前账号，否则需提供 `{ name, password }` 创建账号并登录）
  - `GET|POST /orgs/:org/tokens`（创建时返回 `{ token, record }`）、`DELETE /orgs/:org/tokens/:id`
  - `GET|POST /orgs/:org/products`、`GET|PATCH /orgs/:org/products/:id`、`GET /orgs/:org/products/:id/roles`、`PUT /orgs/:org/products/:id/roles/:memberId`

- [ ] **Step 1: 写失败的测试**

`apps/web/test/api/orgs.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
});
afterAll(() => cleanup());

describe('组织与产品', () => {
  it('查看组织；非成员访问别的组织得到 404', async () => {
    const r = await call(app, 'GET', '/orgs/acme', { session });
    expect(r.body).toMatchObject({ org: { slug: 'acme' }, me: { orgRole: 'owner' } });
    expect((await call(app, 'GET', '/orgs/other', { session })).status).toBe(404);
    expect((await call(app, 'GET', '/orgs/acme')).status).toBe(401);
  });

  it('创建与列出产品', async () => {
    const c = await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } });
    expect(c.status).toBe(201);
    productId = c.body.product.id;
    const l = await call(app, 'GET', '/orgs/acme/products', { session });
    expect(l.body.products.map((p: { key: string }) => p.key)).toEqual(['PAN']);
  });
});

describe('成员与邀请', () => {
  it('登记无账号成员、分配职能标签', async () => {
    const m = await call(app, 'POST', '/orgs/acme/members', { session, body: { displayName: '王总' } });
    expect(m.status).toBe(201);
    const tags = await call(app, 'GET', '/orgs/acme/function-tags', { session });
    const pm = tags.body.tags.find((x: { name: string }) => x.name === '产品经理');
    const set = await call(app, 'PUT', `/orgs/acme/members/${m.body.member.id}/function-tags`, { session, body: { tagIds: [pm.id] } });
    expect(set.body.member.functionTagIds).toEqual([pm.id]);
  });

  it('发出邀请，新用户凭链接注册并加入，随后可以访问组织', async () => {
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'new@example.com', orgRole: 'member' } });
    expect(inv.status).toBe(201);
    expect(inv.body.link).toBe(`http://localhost:3000/invite/${inv.body.token}`);

    const preview = await call(app, 'GET', `/invitations/${inv.body.token}`);
    expect(preview.body).toMatchObject({ orgSlug: 'acme', status: 'pending', accountExists: false });

    const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '新人', password: 'password123' } });
    expect(accept.status).toBe(200);
    const newSession = sessionFrom(accept.res);
    const products = await call(app, 'GET', '/orgs/acme/products', { session: newSession });
    expect(products.body.products[0].myRole).toBe('editor');
    expect((await call(app, 'POST', '/orgs/acme/products', { session: newSession, body: { name: 'x', key: 'XX' } })).status).toBe(403);
  });

  it('未登录且未提供姓名密码时接受邀请失败', async () => {
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'b@example.com', orgRole: 'guest' } });
    const r = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: {} });
    expect(r.status).toBe(400);
  });
});

describe('API Token', () => {
  it('Agent 只读 Token 只能读指定产品，不能写', async () => {
    const agent = await call(app, 'POST', '/orgs/acme/agents', { session, body: { displayName: 'PRD 助手' } });
    const issued = await call(app, 'POST', '/orgs/acme/tokens', {
      session,
      body: { memberId: agent.body.member.id, name: 'Claude Code', scope: { products: [productId], access: 'read' } },
    });
    expect(issued.status).toBe(201);
    const token: string = issued.body.token;

    const read = await call(app, 'GET', `/orgs/acme/products/${productId}`, { token });
    expect(read.body.product.myRole).toBe('viewer');
    expect((await call(app, 'PATCH', `/orgs/acme/products/${productId}`, { token, body: { name: '改名' } })).status).toBe(403);
    expect((await call(app, 'GET', '/orgs/other/products', { token })).status).toBe(404);

    await call(app, 'DELETE', `/orgs/acme/tokens/${issued.body.record.id}`, { session });
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}`, { token })).status).toBe(401);
  });

  it('产品角色覆盖', async () => {
    const guest = await call(app, 'POST', '/orgs/acme/members', { session, body: { displayName: '外部顾问' } });
    const id = guest.body.member.id;
    await call(app, 'PATCH', `/orgs/acme/members/${id}`, { session, body: { orgRole: 'guest' } });
    const set = await call(app, 'PUT', `/orgs/acme/products/${productId}/roles/${id}`, { session, body: { role: 'viewer' } });
    expect(set.status).toBe(204);
    const roles = await call(app, 'GET', `/orgs/acme/products/${productId}/roles`, { session });
    expect(roles.body.roles).toContainEqual({ memberId: id, role: 'viewer' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web test orgs`
Expected: FAIL，多数请求返回 404（路由未注册）。

- [ ] **Step 3: 实现路由**

`apps/web/src/server/routes/orgs.ts`：

```ts
import { createOrganization, getOrganization, listMyOrganizations, updateOrganization } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';
import { readJson } from '../http';

export function registerOrgRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs', async (c) => c.json({ orgs: await listMyOrganizations(deps.db, requireAccount(c).id) }));

  app.post('/orgs', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(c, z.object({ name: z.string(), slug: z.string() }));
    const { org } = await createOrganization(deps.db, account, body);
    return c.json({ org }, 201);
  });

  app.get('/orgs/:org', async (c) => {
    const actor = c.get('actor');
    return c.json({ org: await getOrganization(deps.db, actor), me: { memberId: actor.memberId, orgRole: actor.orgRole } });
  });

  app.patch('/orgs/:org', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), timezone: z.string().optional() }));
    return c.json({ org: await updateOrganization(deps.db, c.get('actor'), body) });
  });
}
```

`apps/web/src/server/routes/members.ts`：

```ts
import {
  createAgentMember,
  createFunctionTag,
  createPlaceholderMember,
  deleteFunctionTag,
  listFunctionTags,
  listMembers,
  ORG_ROLES,
  setMemberFunctionTags,
  updateFunctionTag,
  updateMember,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerMemberRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/members', async (c) => c.json({ members: await listMembers(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/members', async (c) => {
    const body = await readJson(c, z.object({ displayName: z.string(), email: z.string().optional(), department: z.string().optional() }));
    return c.json({ member: await createPlaceholderMember(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/members/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        displayName: z.string().optional(),
        email: z.string().nullable().optional(),
        department: z.string().nullable().optional(),
        orgRole: z.enum(ORG_ROLES).optional(),
        status: z.enum(['active', 'left']).optional(),
      }),
    );
    return c.json({ member: await updateMember(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/members/:id/function-tags', async (c) => {
    const body = await readJson(c, z.object({ tagIds: z.array(z.string()) }));
    return c.json({ member: await setMemberFunctionTags(deps.db, c.get('actor'), c.req.param('id'), body.tagIds) });
  });

  app.post('/orgs/:org/agents', async (c) => {
    const body = await readJson(c, z.object({ displayName: z.string(), orgRole: z.enum(['member', 'guest']).optional() }));
    return c.json({ member: await createAgentMember(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/function-tags', async (c) => c.json({ tags: await listFunctionTags(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/function-tags', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), color: z.string() }));
    return c.json({ tag: await createFunctionTag(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/function-tags/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), color: z.string().optional(), sort: z.number().int().optional() }));
    return c.json({ tag: await updateFunctionTag(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.delete('/orgs/:org/function-tags/:id', async (c) => {
    await deleteFunctionTag(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
}
```

`apps/web/src/server/routes/invitations.ts`：

```ts
import {
  acceptInvitation,
  AppError,
  createInvitation,
  createSession,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson, sessionMeta, setSessionCookie } from '../http';

export function registerInvitationRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/invitations', async (c) => c.json({ invitations: await listInvitations(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/invitations', async (c) => {
    const body = await readJson(
      c,
      z.object({ email: z.string(), orgRole: z.enum(['admin', 'member', 'guest']), memberId: z.string().optional() }),
    );
    const { invitation, token } = await createInvitation(deps.db, c.get('actor'), body);
    return c.json({ invitation, token, link: `${deps.publicUrl}/invite/${token}` }, 201);
  });

  app.delete('/orgs/:org/invitations/:id', async (c) => {
    await revokeInvitation(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get('/invitations/:token', async (c) => {
    const preview = await previewInvitation(deps.db, c.req.param('token'));
    if (!preview) throw new AppError('not_found', '邀请不存在');
    return c.json(preview);
  });

  app.post('/invitations/:token/accept', async (c) => {
    const account = c.get('account');
    const body = await readJson(c, z.object({ name: z.string().optional(), password: z.string().optional() }));
    let who: Parameters<typeof acceptInvitation>[2];
    if (account) {
      who = { accountId: account.id };
    } else {
      if (!body.name || !body.password) throw new AppError('invalid', '请填写姓名和密码');
      who = { newAccount: { name: body.name, password: body.password } };
    }
    const r = await acceptInvitation(deps.db, c.req.param('token'), who);
    if (!account) {
      const s = await createSession(deps.db, r.accountId, sessionMeta(c));
      setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies);
    }
    return c.json({ orgSlug: r.orgSlug });
  });
}
```

`apps/web/src/server/routes/tokens.ts`：

```ts
import { issueToken, listTokens, revokeToken, tokenScopeSchema } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerTokenRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/tokens', async (c) => c.json({ tokens: await listTokens(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/tokens', async (c) => {
    const body = await readJson(
      c,
      z.object({ memberId: z.string(), name: z.string(), scope: tokenScopeSchema, expiresAt: z.coerce.date().nullable().optional() }),
    );
    const r = await issueToken(deps.db, c.get('actor'), body);
    return c.json(r, 201);
  });

  app.delete('/orgs/:org/tokens/:id', async (c) => {
    await revokeToken(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
}
```

`apps/web/src/server/routes/products.ts`：

```ts
import {
  createProduct,
  getProduct,
  listProductRoles,
  listProducts,
  PRODUCT_ROLES,
  setProductRole,
  updateProduct,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerProductRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products', async (c) => c.json({ products: await listProducts(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/products', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), key: z.string(), workflowVersionId: z.string().optional() }));
    return c.json({ product: await createProduct(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/products/:id', async (c) =>
    c.json({ product: await getProduct(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.patch('/orgs/:org/products/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), status: z.enum(['active', 'archived']).optional() }));
    return c.json({ product: await updateProduct(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.get('/orgs/:org/products/:id/roles', async (c) =>
    c.json({ roles: await listProductRoles(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.put('/orgs/:org/products/:id/roles/:memberId', async (c) => {
    const body = await readJson(c, z.object({ role: z.enum(PRODUCT_ROLES).nullable() }));
    await setProductRole(deps.db, c.get('actor'), c.req.param('id'), c.req.param('memberId'), body.role);
    return c.body(null, 204);
  });
}
```

在 `apps/web/src/server/api.ts` 中导入并在 `// Task 16` 注释处注册：

```ts
import { registerInvitationRoutes } from './routes/invitations';
import { registerMemberRoutes } from './routes/members';
import { registerOrgRoutes } from './routes/orgs';
import { registerProductRoutes } from './routes/products';
import { registerTokenRoutes } from './routes/tokens';
```

```ts
  registerOrgRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerInvitationRoutes(app, deps);
  registerTokenRoutes(app, deps);
  registerProductRoutes(app, deps);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/web test`
Expected: PASS（`auth.test.ts` 8 个、`orgs.test.ts` 7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web
git commit -m "feat(web): 组织、成员、邀请、Token 与产品 API"
```

---

### Task 17: 配置定义 API（流程、字段、层级叫法）

**Files:**
- Create: `apps/web/src/server/routes/definitions.ts`
- Modify: `apps/web/src/server/api.ts`
- Test: `apps/web/test/api/definitions.test.ts`

**Interfaces:**
- Consumes: Task 13、14 的服务函数
- Produces（HTTP）：
  - `GET|POST /orgs/:org/workflows`、`GET /orgs/:org/workflows/:id`、`POST /orgs/:org/workflows/:id/versions`
  - `GET|PUT /orgs/:org/products/:id/workflow`（PUT 体 `{ versionId }`）、`POST /orgs/:org/products/:id/workflow/fork`（体 `{ fromVersionId }`）
  - `GET /orgs/:org/fields?product=<id>`、`POST /orgs/:org/fields/:fieldId/options`、`PUT /orgs/:org/fields/:fieldId/options/order`、`PATCH /orgs/:org/field-options/:optionId`、`POST /orgs/:org/products/:id/fields/:fieldId/fork`
  - `GET|PUT /orgs/:org/level-names`、`GET|PUT /orgs/:org/products/:id/level-names`（PUT 体 `{ names: string[] | null }`）

- [ ] **Step 1: 写失败的测试**

`apps/web/test/api/definitions.test.ts`：

```ts
import { DEFAULT_WORKFLOW_BODY } from '@flower/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
});
afterAll(() => cleanup());

describe('流程', () => {
  it('列出模板、发布非法版本返回问题清单、发布合法版本', async () => {
    const list = await call(app, 'GET', '/orgs/acme/workflows', { session });
    const id = list.body.workflows[0].id;
    const bad = await call(app, 'POST', `/orgs/acme/workflows/${id}/versions`, {
      session, body: { body: { ...DEFAULT_WORKFLOW_BODY, initial: 'ghost' } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ path: 'initial', message: '初始状态「ghost」不存在' }]);
    const ok = await call(app, 'POST', `/orgs/acme/workflows/${id}/versions`, { session, body: { body: DEFAULT_WORKFLOW_BODY, note: '重新发布' } });
    expect(ok.status).toBe(201);
    expect(ok.body.version.version).toBe(2);
    const detail = await call(app, 'GET', `/orgs/acme/workflows/${id}`, { session });
    expect(detail.body.versions).toHaveLength(2);
  });

  it('产品复制流程并切换', async () => {
    const pw = await call(app, 'GET', `/orgs/acme/products/${productId}/workflow`, { session });
    const fork = await call(app, 'POST', `/orgs/acme/products/${productId}/workflow/fork`, {
      session, body: { fromVersionId: pw.body.version.id },
    });
    expect(fork.status).toBe(201);
    const after = await call(app, 'GET', `/orgs/acme/products/${productId}/workflow`, { session });
    expect(after.body.definition.productId).toBe(productId);
    const back = await call(app, 'PUT', `/orgs/acme/products/${productId}/workflow`, { session, body: { versionId: pw.body.version.id } });
    expect(back.status).toBe(204);
  });
});

describe('字段与层级', () => {
  it('给平台字段加选项，产品覆盖优先级', async () => {
    const fields = await call(app, 'GET', '/orgs/acme/fields', { session });
    const platform = fields.body.fields.find((f: { key: string }) => f.key === 'platform');
    const opt = await call(app, 'POST', `/orgs/acme/fields/${platform.id}/options`, { session, body: { label: 'PC客户端' } });
    expect(opt.status).toBe(201);
    const upd = await call(app, 'PATCH', `/orgs/acme/field-options/${opt.body.option.id}`, { session, body: { active: false } });
    expect(upd.body.option.active).toBe(false);

    const priority = fields.body.fields.find((f: { key: string }) => f.key === 'priority');
    const fork = await call(app, 'POST', `/orgs/acme/products/${productId}/fields/${priority.id}/fork`, { session });
    expect(fork.status).toBe(201);
    const effective = await call(app, 'GET', `/orgs/acme/fields?product=${productId}`, { session });
    expect(effective.body.fields.find((f: { key: string }) => f.key === 'priority').productId).toBe(productId);
  });

  it('层级叫法', async () => {
    const put = await call(app, 'PUT', '/orgs/acme/level-names', { session, body: { names: ['产品线', '能力'] } });
    expect(put.body.names).toEqual(['产品线', '能力']);
    await call(app, 'PUT', `/orgs/acme/products/${productId}/level-names`, { session, body: { names: ['模块'] } });
    const get = await call(app, 'GET', `/orgs/acme/products/${productId}/level-names`, { session });
    expect(get.body).toEqual({ names: ['模块'], source: 'product' });
    const bad = await call(app, 'PUT', '/orgs/acme/level-names', { session, body: { names: [] } });
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web test definitions`
Expected: FAIL，请求返回 404（路由未注册）。

- [ ] **Step 3: 实现**

`apps/web/src/server/routes/definitions.ts`：

```ts
import {
  addFieldOption,
  createWorkflowTemplate,
  forkFieldForProduct,
  forkWorkflowForProduct,
  getLevelNames,
  getProductWorkflow,
  getWorkflowDefinition,
  listFields,
  listWorkflowTemplates,
  publishWorkflowVersion,
  reorderFieldOptions,
  setOrgLevelNames,
  setProductLevelNames,
  setProductWorkflowVersion,
  updateFieldOption,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerDefinitionRoutes(app: App, deps: ApiDeps): void {
  // 流程
  app.get('/orgs/:org/workflows', async (c) => c.json({ workflows: await listWorkflowTemplates(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/workflows', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), body: z.unknown(), note: z.string().optional() }));
    return c.json(await createWorkflowTemplate(deps.db, c.get('actor'), body), 201);
  });

  app.get('/orgs/:org/workflows/:id', async (c) =>
    c.json(await getWorkflowDefinition(deps.db, c.get('actor'), c.req.param('id'))),
  );

  app.post('/orgs/:org/workflows/:id/versions', async (c) => {
    const body = await readJson(c, z.object({ body: z.unknown(), note: z.string().optional() }));
    return c.json({ version: await publishWorkflowVersion(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.get('/orgs/:org/products/:id/workflow', async (c) =>
    c.json(await getProductWorkflow(deps.db, c.get('actor'), c.req.param('id'))),
  );

  app.put('/orgs/:org/products/:id/workflow', async (c) => {
    const body = await readJson(c, z.object({ versionId: z.string() }));
    await setProductWorkflowVersion(deps.db, c.get('actor'), c.req.param('id'), body.versionId);
    return c.body(null, 204);
  });

  app.post('/orgs/:org/products/:id/workflow/fork', async (c) => {
    const body = await readJson(c, z.object({ fromVersionId: z.string() }));
    return c.json(await forkWorkflowForProduct(deps.db, c.get('actor'), c.req.param('id'), body), 201);
  });

  // 字段字典
  app.get('/orgs/:org/fields', async (c) =>
    c.json({ fields: await listFields(deps.db, c.get('actor'), { productId: c.req.query('product') || undefined }) }),
  );

  app.post('/orgs/:org/fields/:fieldId/options', async (c) => {
    const body = await readJson(c, z.object({ label: z.string(), color: z.string().nullable().optional(), key: z.string().optional() }));
    return c.json({ option: await addFieldOption(deps.db, c.get('actor'), c.req.param('fieldId'), body) }, 201);
  });

  app.put('/orgs/:org/fields/:fieldId/options/order', async (c) => {
    const body = await readJson(c, z.object({ optionIds: z.array(z.string()) }));
    return c.json({ options: await reorderFieldOptions(deps.db, c.get('actor'), c.req.param('fieldId'), body.optionIds) });
  });

  app.patch('/orgs/:org/field-options/:optionId', async (c) => {
    const body = await readJson(
      c,
      z.object({ label: z.string().optional(), color: z.string().nullable().optional(), active: z.boolean().optional() }),
    );
    return c.json({ option: await updateFieldOption(deps.db, c.get('actor'), c.req.param('optionId'), body) });
  });

  app.post('/orgs/:org/products/:id/fields/:fieldId/fork', async (c) =>
    c.json({ field: await forkFieldForProduct(deps.db, c.get('actor'), c.req.param('id'), c.req.param('fieldId')) }, 201),
  );

  // 结构树层级叫法
  app.get('/orgs/:org/level-names', async (c) => c.json(await getLevelNames(deps.db, c.get('actor'))));

  app.put('/orgs/:org/level-names', async (c) => {
    const body = await readJson(c, z.object({ names: z.array(z.string()) }));
    return c.json({ names: await setOrgLevelNames(deps.db, c.get('actor'), body.names) });
  });

  app.get('/orgs/:org/products/:id/level-names', async (c) =>
    c.json(await getLevelNames(deps.db, c.get('actor'), c.req.param('id'))),
  );

  app.put('/orgs/:org/products/:id/level-names', async (c) => {
    const body = await readJson(c, z.object({ names: z.array(z.string()).nullable() }));
    await setProductLevelNames(deps.db, c.get('actor'), c.req.param('id'), body.names);
    return c.body(null, 204);
  });
}
```

在 `api.ts` 导入 `registerDefinitionRoutes` 并在 `// Task 17` 注释处调用 `registerDefinitionRoutes(app, deps);`，然后删除 `// Task 16`、`// Task 17` 两行注释。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: core 与 web 全部测试 PASS，typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add apps/web
git commit -m "feat(web): 流程、字段字典与层级叫法 API"
```

---

### Task 18: Docker 镜像、自托管 compose 与冒烟测试

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`, `docker-compose.yml`, `scripts/smoke.sh`

**Interfaces:**
- Consumes: `packages/core` 的 `build:migrate`、`migrations/`；`apps/web` 的 standalone 构建
- Produces: 镜像 `flower:local`；`docker compose up` 启动 postgres + flower；`scripts/smoke.sh` 冒烟测试

- [ ] **Step 1: 写镜像与 compose**

`.dockerignore`：

```
**/node_modules
**/.next
**/dist
.git
.env
**/.env.local
docs
```

`Dockerfile`：

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @flower/core build:migrate && pnpm --filter @flower/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 FLOWER_MIGRATIONS_DIR=/app/migrations
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/packages/core/dist/migrate.mjs ./migrate.mjs
COPY --from=build /repo/packages/core/migrations ./migrations
COPY docker/entrypoint.sh ./entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["sh", "./entrypoint.sh"]
```

`docker/entrypoint.sh`：

```sh
#!/bin/sh
set -e
node migrate.mjs
exec node apps/web/server.js
```

`docker-compose.yml`：

```yaml
# 自托管部署：cp .env.example .env，填好密码与密钥后执行 docker compose up -d
# 密码请只用字母和数字（会拼进数据库连接串），可用 openssl rand -hex 24 生成
services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: flower_admin
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD:?请在 .env 中设置 POSTGRES_ADMIN_PASSWORD}
      POSTGRES_DB: flower
    volumes:
      - flower_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U flower_admin -d flower"]
      interval: 3s
      timeout: 3s
      retries: 30

  flower:
    build: .
    image: flower:local
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://flower_app:${FLOWER_APP_DB_PASSWORD:?请在 .env 中设置 FLOWER_APP_DB_PASSWORD}@postgres:5432/flower
      DATABASE_ADMIN_URL: postgres://flower_admin:${POSTGRES_ADMIN_PASSWORD}@postgres:5432/flower
      FLOWER_APP_DB_PASSWORD: ${FLOWER_APP_DB_PASSWORD}
      FLOWER_SECRET_KEY: ${FLOWER_SECRET_KEY:?请在 .env 中设置 FLOWER_SECRET_KEY（openssl rand -base64 48）}
      FLOWER_PUBLIC_URL: ${FLOWER_PUBLIC_URL:-http://localhost:3000}
    ports:
      - "${FLOWER_PORT:-3000}:3000"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/v1/setup/status"]
      interval: 5s
      timeout: 3s
      retries: 30

volumes:
  flower_pg: {}
```

在 `.env.example` 末尾追加：

```
# 自托管（docker-compose.yml）专用
POSTGRES_ADMIN_PASSWORD=
FLOWER_PORT=3000
```

- [ ] **Step 2: 写冒烟测试脚本**

`scripts/smoke.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=flower_smoke
export POSTGRES_ADMIN_PASSWORD=smokeadmin123
export FLOWER_APP_DB_PASSWORD=smokeapp123
export FLOWER_SECRET_KEY="$(openssl rand -hex 32)"
export FLOWER_PORT=3900
export FLOWER_PUBLIC_URL=http://localhost:3900
BASE=http://localhost:3900/api/v1
JAR="$(mktemp)"
trap 'docker compose down -v >/dev/null 2>&1; rm -f "$JAR"' EXIT

docker compose up -d --build --wait

echo "1. 缺少密钥时镜像拒绝启动"
if docker run --rm -e DATABASE_URL=x -e DATABASE_ADMIN_URL=x -e FLOWER_APP_DB_PASSWORD=x flower:local 2>&1 | grep -q 'FLOWER_SECRET_KEY'; then
  echo "   通过"
else
  echo "   失败：未提示缺少 FLOWER_SECRET_KEY"; exit 1
fi

echo "2. 初始化前状态"
curl -fs "$BASE/setup/status" | grep -q '"initialized":false'

echo "3. 初始化并自动登录"
curl -fs -c "$JAR" -H 'content-type: application/json' \
  -d '{"admin":{"email":"owner@example.com","name":"Owner","password":"password123"},"org":{"name":"冒烟组织","slug":"smoke"}}' \
  "$BASE/setup" >/dev/null
curl -fs -b "$JAR" "$BASE/me" | grep -q '"slug":"smoke"'

echo "4. 重新登录（验证 argon2 原生模块在镜像内可用）"
curl -fs -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"password123"}' "$BASE/auth/login" >/dev/null

echo "5. 重启后数据仍在，迁移可重复执行"
docker compose restart flower >/dev/null
docker compose up -d --wait >/dev/null
curl -fs "$BASE/setup/status" | grep -q '"initialized":true'

echo "冒烟测试通过"
```

```bash
chmod +x scripts/smoke.sh
```

- [ ] **Step 3: 运行冒烟测试**

Run: `./scripts/smoke.sh`
Expected: 依次输出 1–5 项并以"冒烟测试通过"结束，退出码 0。若第 4 步失败并提示找不到 `@node-rs/argon2-linux-*` 模块，检查 `next.config.ts` 中 `serverExternalPackages` 是否包含 `@node-rs/argon2`。

- [ ] **Step 4: 提交**

```bash
git add Dockerfile .dockerignore docker docker-compose.yml scripts/smoke.sh .env.example
git commit -m "feat: docker 镜像、自托管 compose 与冒烟测试"
```

---

### Task 19: 项目命令文档

**Files:**
- Create: `CLAUDE.md`, `README.md`

- [ ] **Step 1: 写 CLAUDE.md**

```markdown
# Flower

多组织、多产品的产品研发管理平台。设计文档：`docs/superpowers/specs/2026-09-28-flower-data-model-design.md`。

## 命令

| 用途 | 命令 |
|---|---|
| 启动开发数据库（端口 54329） | `pnpm db:up` |
| 执行迁移（读 apps/web/.env.local） | `pnpm db:migrate` |
| 开发服务器 | `pnpm dev` |
| 全部测试（需要先 db:up） | `pnpm test` |
| 类型检查 | `pnpm typecheck` |
| 修改 schema 后生成迁移 | `pnpm --filter @flower/core db:generate` |
| 镜像冒烟测试 | `./scripts/smoke.sh` |

首次开发：`cp .env.example apps/web/.env.local`，填入 `FLOWER_SECRET_KEY`（`openssl rand -base64 48`）。

## 约定

- 业务逻辑只写在 `packages/core`，服务函数签名为 `(db, actor, input)`；`apps/web/src/server/routes` 只做参数校验和调用。
- 租户数据一律在 `withOrg(db, actor.orgId, ...)` 中读写；`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受。
- 新增租户表必须带 `org_id`，并在一个新的自定义迁移里为它开启 RLS（参照 `0002_rls.sql`）。
- 每个写操作在同一事务内调用 `recordEvent`。
- 服务函数一律声明为 `async`，保证权限校验失败以 Promise 拒绝的形式返回。
- 面向用户的错误信息用中文，通过 `AppError(code, message, details?)` 抛出。
```

- [ ] **Step 2: 写 README.md**

```markdown
# Flower

多组织、多产品的产品研发管理平台：需求、迭代、PRD、通知、知识库，并通过 MCP 向外部 Agent 开放。

## 自托管

1. `cp .env.example .env`，填写 `POSTGRES_ADMIN_PASSWORD`、`FLOWER_APP_DB_PASSWORD`（只用字母数字，`openssl rand -hex 24`）和 `FLOWER_SECRET_KEY`（`openssl rand -base64 48`）。
2. `docker compose up -d`
3. 打开 `http://localhost:3000`，按初始化向导创建管理员和第一个组织。

默认为邀请制，实例管理员可在实例设置中开放注册。

## 开发

见 `CLAUDE.md`。
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md README.md
git commit -m "docs: 项目命令与自托管说明"
```

---

## P0-A 完成标准

- `pnpm test` 全部通过（core 约 84 个用例，web 约 19 个用例）。
- `./scripts/smoke.sh` 通过。
- P0-B（管理界面）在此基础上开发，届时进行 P0 的界面验收演示。
