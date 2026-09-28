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
