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
import { DOCUMENT_STATUSES, EXTERNAL_PROVIDERS, type RevisionSnapshot, type TemplateSection } from '../documents/constants';
import { newId } from '../ids';
import { LINK_ORIGINS, LINK_SOURCE_TYPES, LINK_TARGET_TYPES } from '../links/syntax';

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
    kind: text('kind', { enum: ['change', 'module'] }).notNull().default('change'),
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
