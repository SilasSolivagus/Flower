import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { TokenScope } from '../domain-types';
import { AFFECTED_CHANGE_TYPES, DOCUMENT_KINDS, DOCUMENT_STATUSES, EXTERNAL_PROVIDERS, MERGE_STATUSES, type RevisionSnapshot, type TemplateSection } from '../documents/constants';
import { newId } from '../ids';
import { LINK_ORIGINS, LINK_SOURCE_TYPES, LINK_TARGET_TYPES } from '../links/syntax';
import {
  ALERT_STATES,
  BUILTIN_TEMPLATE_KEYS,
  CHANNEL_KINDS,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  type DeliveryPayload,
  MEMBER_NOTIFICATION_KINDS,
  NOTIFICATION_SUBJECT_TYPES,
  RULE_MODES,
  type RuleFilter,
  SCHEDULE_SOURCES,
  SUBSCRIPTION_SOURCES,
  SUBSCRIPTION_SUBJECT_TYPES,
  TEMPLATE_FORMATS,
} from '../notifications/constants';

const id = () => uuid('id').primaryKey().$defaultFn(newId);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const orgRef = () => uuid('org_id').notNull().references(() => organizations.id);

export type AccountPreferences = { theme?: 'light' | 'dark' | 'system'; locale?: string; timezone?: string };
/** tracking：跟进的老化阈值（P3-C1），缺省或无效时取默认值，见 tracking/aging.ts 的 trackingSettingsOf。 */
export type OrgSettings = {
  timezone?: string;
  structureLevelNames?: string[];
  tracking?: { warnDays?: number; alertDays?: number; staleUpdateDays?: number };
};

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

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_expires_at').on(t.expiresAt)],
);

export const authThrottle = pgTable('auth_throttle', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStart: ts('window_start').notNull().defaultNow(),
  lockedUntil: ts('locked_until'),
});

// ---------- 租户表（RLS，见 0002_rls.sql） ----------

export const organizations = pgTable('organizations', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<OrgSettings>().notNull().default({}),
  /** 个人通知的邮件通道（P3-B1）；通道删除时置空。 */
  personalEmailChannelId: uuid('personal_email_channel_id').references((): AnyPgColumn => notificationChannels.id, { onDelete: 'set null' }),
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
    requirementSeq: integer('requirement_seq').notNull().default(0),
    documentSeq: integer('document_seq').notNull().default(0),
    taskSeq: integer('task_seq').notNull().default(0),
    /** 个人提醒通道（P3-B1）：对本产品可用、已启用的企业微信机器人通道；通道删除时置空。 */
    personalChannelId: uuid('personal_channel_id').references((): AnyPgColumn => notificationChannels.id, { onDelete: 'set null' }),
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
    /** 企业微信账号（userid），同一组织内唯一（P3-B1）。 */
    wecomUserid: text('wecom_userid'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('members_org_account').on(t.orgId, t.accountId),
    index('members_account').on(t.accountId),
    uniqueIndex('members_org_wecom').on(t.orgId, t.wecomUserid).where(sql`${t.wecomUserid} is not null`),
  ],
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

// ---------- P1-A：需求、迭代、任务 ----------

export type IterationMilestone = { label: string; date: string };
export const RELATION_TYPES = ['duplicate_of', 'merged_into', 'derived_from', 'blocks', 'related'] as const;
const CHECK_STATE_ENUM = ['not_started', 'in_progress', 'passed', 'rejected', 'not_needed'] as const;
const productRef = () => uuid('product_id').notNull().references(() => products.id);
const memberRef = (name: string) => uuid(name).references(() => members.id);

export const structureNodes = pgTable(
  'structure_nodes',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    parentId: uuid('parent_id').references((): AnyPgColumn => structureNodes.id),
    depth: smallint('depth').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: ['active', 'deprecated'] }).notNull().default('active'),
    sort: integer('sort').notNull().default(0),
    legacyKey: text('legacy_key'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('structure_nodes_parent_name').on(t.productId, t.parentId, t.name).nullsNotDistinct(),
    check('structure_nodes_depth', sql`${t.depth} between 1 and 3`),
  ],
);

export const iterations = pgTable(
  'iterations',
  {
    id: id(),
    orgId: orgRef(),
    productId: uuid('product_id').references(() => products.id),
    type: text('type', { enum: ['regular', 'special'] }).notNull(),
    name: text('name').notNull(),
    legacyKey: text('legacy_key'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    baselineEndDate: date('baseline_end_date', { mode: 'string' }),
    status: text('status', { enum: ['planning', 'active', 'done', 'canceled'] }).notNull().default('planning'),
    milestones: jsonb('milestones').$type<IterationMilestone[]>().notNull().default([]),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('iterations_type_product', sql`(${t.type} = 'regular') = (${t.productId} is not null)`),
    check('iterations_dates', sql`${t.startDate} <= ${t.endDate}`),
    index('iterations_product').on(t.productId),
    uniqueIndex('iterations_product_name').on(t.productId, t.name).where(sql`${t.deletedAt} is null`),
  ],
);

export const releases = pgTable(
  'releases',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    platformOptionId: uuid('platform_option_id').references(() => fieldOptions.id),
    versionName: text('version_name').notNull(),
    iterationId: uuid('iteration_id').references(() => iterations.id),
    status: text('status', { enum: ['planned', 'released'] }).notNull().default('planned'),
    plannedDate: date('planned_date', { mode: 'string' }),
    baselineDate: date('baseline_date', { mode: 'string' }),
    releasedAt: ts('released_at'),
    notes: text('notes'),
    legacyKey: text('legacy_key'),
    createdAt: createdAt(),
  },
  (t) => [index('releases_product').on(t.productId)],
);

export const requirements = pgTable(
  'requirements',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    number: integer('number').notNull(),
    legacyKey: text('legacy_key'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    stateKey: text('state_key').notNull(),
    stateChangedAt: ts('state_changed_at').notNull().defaultNow(),
    ownerMemberId: memberRef('owner_member_id'),
    requesterMemberId: memberRef('requester_member_id'),
    nodeId: uuid('node_id').references(() => structureNodes.id),
    iterationId: uuid('iteration_id').references(() => iterations.id),
    changeDocumentId: uuid('change_document_id').references((): AnyPgColumn => documents.id),
    legacyMeta: jsonb('legacy_meta').$type<Record<string, unknown>>(),
    createdBy: memberRef('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('requirements_product_number').on(t.productId, t.number),
    index('requirements_product_state').on(t.productId, t.stateKey),
    index('requirements_product_updated').on(t.productId, t.updatedAt.desc()),
    index('requirements_owner').on(t.ownerMemberId),
    index('requirements_iteration').on(t.iterationId),
    index('requirements_change_document').on(t.changeDocumentId),
  ],
);

export const iterationScopeSnapshots = pgTable('iteration_scope_snapshots', {
  id: id(),
  orgId: orgRef(),
  iterationId: uuid('iteration_id').notNull().references(() => iterations.id),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
  snapshotKind: text('snapshot_kind', { enum: ['committed'] }).notNull(),
  at: ts('at').notNull().defaultNow(),
});

export const requirementReleases = pgTable(
  'requirement_releases',
  {
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    releaseId: uuid('release_id').notNull().references(() => releases.id),
  },
  (t) => [primaryKey({ columns: [t.requirementId, t.releaseId] })],
);

export const fieldValues = pgTable(
  'field_values',
  {
    id: id(),
    orgId: orgRef(),
    entityType: text('entity_type', { enum: ['requirement'] }).notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldId: uuid('field_id').notNull().references(() => fieldDefinitions.id),
    optionId: uuid('option_id').notNull().references(() => fieldOptions.id),
  },
  (t) => [
    uniqueIndex('field_values_entity_option').on(t.entityId, t.fieldId, t.optionId),
    index('field_values_option').on(t.optionId),
  ],
);

export const requirementAssignments = pgTable(
  'requirement_assignments',
  {
    id: id(),
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    memberId: uuid('member_id').notNull().references(() => members.id),
    functionTagId: uuid('function_tag_id').references(() => functionTags.id),
    platformOptionId: uuid('platform_option_id').references(() => fieldOptions.id),
  },
  (t) => [
    index('requirement_assignments_requirement').on(t.requirementId),
    index('requirement_assignments_member').on(t.memberId),
    unique('requirement_assignments_unique').on(t.requirementId, t.memberId, t.functionTagId, t.platformOptionId).nullsNotDistinct(),
  ],
);

export const requirementRelations = pgTable(
  'requirement_relations',
  {
    id: id(),
    orgId: orgRef(),
    fromId: uuid('from_id').notNull().references(() => requirements.id),
    toId: uuid('to_id').notNull().references(() => requirements.id),
    type: text('type', { enum: RELATION_TYPES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('requirement_relations_unique').on(t.fromId, t.toId, t.type)],
);

export const stateTransitions = pgTable(
  'state_transitions',
  {
    id: id(),
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actorMemberId: memberRef('actor_member_id'),
    tokenId: uuid('token_id'),
    forced: boolean('forced').notNull().default(false),
    reason: text('reason'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('state_transitions_requirement').on(t.requirementId, t.at)],
);

export const blockers = pgTable(
  'blockers',
  {
    id: id(),
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    description: text('description').notNull(),
    status: text('status', { enum: ['active', 'resolved'] }).notNull().default('active'),
    ownerMemberId: memberRef('owner_member_id'),
    createdAt: createdAt(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [index('blockers_requirement').on(t.requirementId)],
);

export const checkItemResults = pgTable(
  'check_item_results',
  {
    id: id(),
    orgId: orgRef(),
    targetType: text('target_type', { enum: ['requirement', 'document'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    itemKey: text('item_key').notNull(),
    state: text('state', { enum: CHECK_STATE_ENUM }).notNull(),
    note: text('note'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: memberRef('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('check_item_results_target_item').on(t.targetType, t.targetId, t.itemKey)],
);

export const checkItemSignoffs = pgTable(
  'check_item_signoffs',
  {
    id: id(),
    orgId: orgRef(),
    resultId: uuid('result_id')
      .notNull()
      .references(() => checkItemResults.id, { onDelete: 'cascade' }),
    signerMemberId: uuid('signer_member_id').notNull().references(() => members.id),
    actedByMemberId: memberRef('acted_by_member_id'),
    signerRuleIndex: integer('signer_rule_index').notNull(),
    decision: text('decision', { enum: ['passed', 'rejected'] }).notNull(),
    note: text('note'),
    evidenceLinkId: uuid('evidence_link_id'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('check_item_signoffs_result').on(t.resultId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    number: integer('number').notNull(),
    requirementId: uuid('requirement_id').references(() => requirements.id),
    iterationId: uuid('iteration_id').references(() => iterations.id),
    title: text('title').notNull(),
    alias: text('alias'),
    assigneeMemberId: memberRef('assignee_member_id'),
    status: text('status', { enum: ['todo', 'doing', 'done'] }).notNull().default('todo'),
    planStart: date('plan_start', { mode: 'string' }),
    planDays: real('plan_days'),
    delayDays: real('delay_days'),
    phase: text('phase'),
    flag: text('flag'),
    starred: boolean('starred'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    legacyKey: text('legacy_key'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tasks_product_number').on(t.productId, t.number),
    index('tasks_requirement').on(t.requirementId),
    index('tasks_assignee').on(t.assigneeMemberId),
    index('tasks_iteration').on(t.iterationId),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: id(),
    orgId: orgRef(),
    targetType: text('target_type', { enum: ['requirement', 'document', 'iteration'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id),
    authorMemberId: memberRef('author_member_id'),
    body: text('body').notNull(),
    kind: text('kind', { enum: ['comment', 'update'] }).notNull().default('comment'),
    anchor: jsonb('anchor').$type<Record<string, unknown>>(),
    anchorState: text('anchor_state', { enum: ['ok', 'stale', 'unanchored'] }),
    resolvedAt: ts('resolved_at'),
    resolvedBy: memberRef('resolved_by'),
    createdAt: createdAt(),
  },
  (t) => [index('comments_target').on(t.targetType, t.targetId, t.createdAt)],
);

export const commentReads = pgTable(
  'comment_reads',
  {
    orgId: orgRef(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull().references(() => members.id),
    readAt: ts('read_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.memberId] })],
);

export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: id(),
    orgId: orgRef(),
    entityType: text('entity_type', { enum: ['requirement'] }).notNull(),
    entityId: uuid('entity_id').notNull(),
    alias: text('alias').notNull(),
  },
  (t) => [uniqueIndex('entity_aliases_org_alias').on(t.orgId, t.alias)],
);

// ---------- P2-A：文档 ----------

export const documentTemplates = pgTable(
  'document_templates',
  {
    id: id(),
    orgId: orgRef(),
    productId: uuid('product_id').references(() => products.id),
    kind: text('kind', { enum: ['change', 'module'] }).notNull().default('change'),
    name: text('name').notNull(),
    body: text('body').notNull().default(''),
    sections: jsonb('sections').$type<TemplateSection[]>().notNull().default([]),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_templates_org_name').on(t.orgId, t.kind, t.name).where(sql`${t.productId} is null`),
    uniqueIndex('document_templates_product_name').on(t.productId, t.kind, t.name).where(sql`${t.productId} is not null`),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    number: integer('number').notNull(),
    kind: text('kind', { enum: DOCUMENT_KINDS }).notNull().default('change'),
    source: text('source', { enum: ['native', 'external'] }).notNull(),
    title: text('title').notNull(),
    ownerMemberId: memberRef('owner_member_id'),
    templateId: uuid('template_id').references(() => documentTemplates.id),
    nodeId: uuid('node_id').references(() => structureNodes.id),
    status: text('status', { enum: DOCUMENT_STATUSES }).notNull().default('draft'),
    currentRevisionId: uuid('current_revision_id').references((): AnyPgColumn => documentRevisions.id),
    externalUrl: text('external_url'),
    externalUrlKey: text('external_url_key'),
    externalProvider: text('external_provider', { enum: EXTERNAL_PROVIDERS }),
    version: integer('version').notNull().default(1),
    legacyKey: text('legacy_key'),
    createdBy: memberRef('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('documents_product_number').on(t.productId, t.number),
    uniqueIndex('documents_product_url').on(t.productId, t.externalUrlKey).where(sql`${t.externalUrlKey} is not null and ${t.deletedAt} is null`),
    index('documents_product_updated').on(t.productId, t.updatedAt.desc()),
    check('documents_external', sql`${t.source} <> 'external' or (${t.externalUrl} is not null and ${t.externalUrlKey} is not null and ${t.currentRevisionId} is null)`),
    uniqueIndex('documents_module_node').on(t.nodeId).where(sql`${t.kind} = 'module' and ${t.deletedAt} is null`),
    check('documents_kind_node', sql`(${t.kind} = 'module') = (${t.nodeId} is not null)`),
  ],
);

export const documentRevisions = pgTable(
  'document_revisions',
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid('document_id')
      .notNull()
      .references((): AnyPgColumn => documents.id),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<RevisionSnapshot>().notNull(),
    summary: text('summary'),
    authorMemberId: memberRef('author_member_id'),
    mergedFromDocumentId: uuid('merged_from_document_id'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('document_revisions_doc_version').on(t.documentId, t.version)],
);

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    orgId: orgRef(),
    targetType: text('target_type', { enum: ['document'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    uploaderMemberId: memberRef('uploader_member_id'),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_target').on(t.targetType, t.targetId)],
);

// ---------- P2-B1：双链 ----------

export const entityLinks = pgTable(
  'entity_links',
  {
    id: id(),
    orgId: orgRef(),
    sourceType: text('source_type', { enum: LINK_SOURCE_TYPES }).notNull(),
    sourceId: uuid('source_id').notNull(),
    /** PRD 正文中链接所在小节的原始标题；需求描述与评论为空。 */
    sourceSection: text('source_section'),
    targetType: text('target_type', { enum: LINK_TARGET_TYPES }),
    /** 目标不存在（悬空）时为空；新建或改名的目标按 target_text 接上。 */
    targetId: uuid('target_id'),
    targetSection: text('target_section'),
    /** 规范写法：编号大写，迭代与节点带产品前缀。 */
    targetText: text('target_text').notNull(),
    /** 引用处所在的一句，最多 120 字。 */
    context: text('context').notNull().default(''),
    origin: text('origin', { enum: LINK_ORIGINS }).notNull().default('wikilink'),
    createdAt: createdAt(),
  },
  (t) => [
    index('entity_links_source').on(t.sourceType, t.sourceId),
    index('entity_links_target').on(t.targetType, t.targetId),
    index('entity_links_org_text').on(t.orgId, t.targetText),
  ],
);

// ---------- P2-B2：影响声明与合入 ----------

export const documentAffectedNodes = pgTable(
  'document_affected_nodes',
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => structureNodes.id),
    changeType: text('change_type', { enum: AFFECTED_CHANGE_TYPES }).notNull(),
    /** PRD 小节的键（splitSections 的标题路径），按声明顺序；空数组表示没有来源。 */
    sourceSections: jsonb('source_sections').$type<string[]>().notNull().default([]),
    mergeStatus: text('merge_status', { enum: MERGE_STATUSES }).notNull().default('pending'),
    mergedRevisionId: uuid('merged_revision_id').references(() => documentRevisions.id),
    /** 应用或跳过的人与时间。 */
    mergedBy: memberRef('merged_by'),
    mergedAt: ts('merged_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('document_affected_nodes_doc_node').on(t.documentId, t.nodeId), index('document_affected_nodes_node').on(t.nodeId)],
);

// ---------- P3-A：推送 ----------

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: id(),
    orgId: orgRef(),
    kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
    name: text('name').notNull(),
    /** 所属群，仅用于展示与归组。 */
    groupLabel: text('group_label'),
    /** 加密后的配置（notifications/secrets.ts 的 `v1:…`），明文只在发送时解密。 */
    config: text('config').notNull(),
    configHint: text('config_hint').notNull(),
    rateLimitPerMin: integer('rate_limit_per_min').notNull(),
    /** 空数组表示全部产品。 */
    allowedProductIds: uuid('allowed_product_ids').array().notNull().default(sql`'{}'`),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_channels_org_name').on(t.orgId, t.name), check('notification_channels_rate', sql`${t.rateLimitPerMin} between 1 and 600`)],
);

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: id(),
    orgId: orgRef(),
    name: text('name').notNull(),
    format: text('format', { enum: TEMPLATE_FORMATS }).notNull(),
    body: text('body').notNull(),
    builtin: boolean('builtin').notNull().default(false),
    /** 预置模板的用途；自建模板为空。 */
    builtinKey: text('builtin_key', { enum: BUILTIN_TEMPLATE_KEYS }),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_templates_org_name').on(t.orgId, t.name),
    uniqueIndex('message_templates_org_builtin').on(t.orgId, t.builtinKey).where(sql`${t.builtinKey} is not null`),
    check('message_templates_builtin', sql`${t.builtin} = (${t.builtinKey} is not null)`),
  ],
);

export const notificationSchedules = pgTable(
  'notification_schedules',
  {
    id: id(),
    orgId: orgRef(),
    /** P3-A 的三种来源都必须有产品（服务层校验）；列可空，留给以后的组织级来源。 */
    productId: uuid('product_id').references(() => products.id),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    source: text('source', { enum: SCHEDULE_SOURCES }).notNull(),
    sourceConfig: jsonb('source_config').$type<Record<string, unknown>>().notNull().default({}),
    channelIds: uuid('channel_ids').array().notNull().default(sql`'{}'`),
    templateId: uuid('template_id').references(() => messageTemplates.id),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: ts('next_run_at'),
    lastRunAt: ts('last_run_at'),
    lastSuccessAt: ts('last_success_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    failThreshold: integer('fail_threshold').notNull().default(1),
    alertState: text('alert_state', { enum: ALERT_STATES }).notNull().default('normal'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('notification_schedules_product').on(t.productId),
    index('notification_schedules_due').on(t.nextRunAt).where(sql`${t.enabled}`),
    check('notification_schedules_threshold', sql`${t.failThreshold} between 1 and 10`),
  ],
);

export const notificationRules = pgTable(
  'notification_rules',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    name: text('name').notNull(),
    eventTypes: text('event_types').array().notNull(),
    filter: jsonb('filter').$type<RuleFilter>().notNull().default({}),
    /** 即时规则的通道；摘要规则为空（用定时推送的通道）。 */
    channelIds: uuid('channel_ids').array().notNull().default(sql`'{}'`),
    templateId: uuid('template_id').references(() => messageTemplates.id),
    mode: text('mode', { enum: RULE_MODES }).notNull().default('immediate'),
    digestScheduleId: uuid('digest_schedule_id').references(() => notificationSchedules.id),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('notification_rules_product').on(t.productId), check('notification_rules_digest', sql`(${t.mode} = 'digest') = (${t.digestScheduleId} is not null)`)],
);

export const notificationDigestItems = pgTable(
  'notification_digest_items',
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => notificationRules.id),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => notificationSchedules.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id),
    /** 被某次执行取用后、发送成功前的执行 id；该次全部放弃时清空，留给下一次。 */
    runId: uuid('run_id'),
    createdAt: createdAt(),
    consumedAt: ts('consumed_at'),
  },
  (t) => [
    uniqueIndex('notification_digest_items_rule_event').on(t.ruleId, t.eventId),
    index('notification_digest_items_open').on(t.scheduleId, t.createdAt).where(sql`${t.consumedAt} is null`),
    index('notification_digest_items_run').on(t.runId),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: id(),
    orgId: orgRef(),
    kind: text('kind', { enum: DELIVERY_KINDS }).notNull(),
    ruleId: uuid('rule_id').references(() => notificationRules.id),
    scheduleId: uuid('schedule_id').references(() => notificationSchedules.id),
    /** 同一次定时执行的记录共享，用于执行结果与告警。 */
    runId: uuid('run_id'),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id),
    eventId: uuid('event_id').references(() => domainEvents.id),
    /** 渲染后的请求体；事件规则的记录在第一次发送前渲染，此前为空。 */
    payload: jsonb('payload').$type<DeliveryPayload>(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** 待发、失败待重试时为下次尝试时间；发送中为租约到期时间。 */
    nextAttemptAt: ts('next_attempt_at'),
    response: text('response'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
    legacyKey: text('legacy_key'),
  },
  (t) => [
    index('notification_deliveries_due').on(t.nextAttemptAt).where(sql`${t.status} in ('pending', 'failed', 'sending')`),
    index('notification_deliveries_channel_sent').on(t.channelId, t.sentAt),
    index('notification_deliveries_org_created').on(t.orgId, t.createdAt.desc()),
    index('notification_deliveries_run').on(t.runId),
    check(
      'notification_deliveries_source',
      sql`(${t.kind} = 'rule' and ${t.ruleId} is not null and ${t.scheduleId} is null) or (${t.kind} = 'schedule' and ${t.scheduleId} is not null and ${t.ruleId} is null) or (${t.kind} in ('test', 'personal') and ${t.ruleId} is null and ${t.scheduleId} is null)`,
    ),
  ],
);

// ---------- P3-B1：站内通知、关注、个人偏好、企业微信 ----------

export const memberNotifications = pgTable(
  'member_notifications',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    /** 系统告警没有对应的领域事件，为空。 */
    eventId: uuid('event_id').references(() => domainEvents.id),
    kind: text('kind', { enum: MEMBER_NOTIFICATION_KINDS }).notNull(),
    subjectType: text('subject_type', { enum: NOTIFICATION_SUBJECT_TYPES }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** 「编号 标题」。 */
    title: text('title').notNull(),
    /** 动作，如「在评论中 @ 了你」。 */
    body: text('body').notNull(),
    /** 站内相对路径，如 /acme/requirements/PAN-12。 */
    url: text('url').notNull(),
    actorMemberId: memberRef('actor_member_id'),
    createdAt: createdAt(),
    readAt: ts('read_at'),
  },
  (t) => [
    uniqueIndex('member_notifications_member_event_kind').on(t.memberId, t.eventId, t.kind).where(sql`${t.eventId} is not null`),
    index('member_notifications_member_created').on(t.memberId, t.createdAt.desc()),
    index('member_notifications_unread').on(t.memberId).where(sql`${t.readAt} is null`),
    index('member_notifications_subject').on(t.memberId, t.subjectType, t.subjectId),
    index('member_notifications_read_at').on(t.readAt).where(sql`${t.readAt} is not null`),
  ],
);

export const memberNotificationPrefs = pgTable(
  'member_notification_prefs',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    kind: text('kind', { enum: MEMBER_NOTIFICATION_KINDS }).notNull(),
    inApp: boolean('in_app').notNull(),
    wecom: boolean('wecom').notNull(),
    email: boolean('email').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('member_notification_prefs_member_kind').on(t.memberId, t.kind)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    subjectType: text('subject_type', { enum: SUBSCRIPTION_SUBJECT_TYPES }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    source: text('source', { enum: SUBSCRIPTION_SOURCES }).notNull(),
    /** 取消关注的时间：不删行，避免被自动关注加回。 */
    mutedAt: ts('muted_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('subscriptions_member_subject').on(t.memberId, t.subjectType, t.subjectId), index('subscriptions_subject').on(t.subjectType, t.subjectId)],
);

/** 站内通知的后台处理进度：每个组织一行。 */
export const notificationCursors = pgTable('notification_cursors', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id),
  /** 最后处理的事件（occurred_at, id）；为空表示从头处理。 */
  lastOccurredAt: ts('last_occurred_at'),
  lastEventId: uuid('last_event_id'),
  /** 连续处理失败的事件与次数：同一条连续失败 3 次后跳过。 */
  failingEventId: uuid('failing_event_id'),
  failures: integer('failures').notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const wecomApps = pgTable(
  'wecom_apps',
  {
    id: id(),
    orgId: orgRef(),
    corpId: text('corp_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** 加密后的应用密钥（notifications/secrets.ts 的 `v1:…`），明文只在换取 access_token 时解密。 */
    secret: text('secret').notNull(),
    secretHint: text('secret_hint').notNull(),
    bindEnabled: boolean('bind_enabled').notNull().default(false),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('wecom_apps_org').on(t.orgId)],
);

/** 扫码绑定的一次性 state：只存 SHA-256，10 分钟过期，用过即作废。 */
export const wecomBindStates = pgTable(
  'wecom_bind_states',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    stateHash: text('state_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('wecom_bind_states_hash').on(t.stateHash)],
);
