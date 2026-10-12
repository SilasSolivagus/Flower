import type * as core from '@flower/core';
import { legacyUuid } from './ids';
import type { LegacyData, PlaneRequirement, PushRequirement } from './legacy-types';
import { type Mapping, type PersonEntry, Resolver } from './mapping';
import { parseLegacyTime } from './normalize';

export type ImportOptions = {
  orgSlug: string;
  orgName: string;
  productKey: string;
  productName: string;
  asOf: string;
  owner: { accountId: string; email: string; name: string } | null;
  /** prd_uploads 导出目录；给了时读取旧附件文件按内容校验，缺失或不合格的不导入。没给时为 undefined（报告里不统计缺失）。 */
  uploadsDir?: string;
  /** 实例密钥 FLOWER_SECRET_KEY：加密推送通道配置。有通道要迁移而没有密钥时计划报问题。 */
  secretKey?: string;
};

type Ins<T extends { $inferInsert: unknown }> = Array<T['$inferInsert']>;
export type ImportRows = {
  organizations: Ins<typeof core.organizations>;
  members: Ins<typeof core.members>;
  functionTags: Ins<typeof core.functionTags>;
  memberFunctionTags: Ins<typeof core.memberFunctionTags>;
  workflowDefinitions: Ins<typeof core.workflowDefinitions>;
  workflowVersions: Ins<typeof core.workflowVersions>;
  products: Ins<typeof core.products>;
  productMembers: Ins<typeof core.productMembers>;
  fieldDefinitions: Ins<typeof core.fieldDefinitions>;
  fieldOptions: Ins<typeof core.fieldOptions>;
  structureNodes: Ins<typeof core.structureNodes>;
  documentTemplates: Ins<typeof core.documentTemplates>;
  documents: Ins<typeof core.documents>;
  documentRevisions: Ins<typeof core.documentRevisions>;
  attachments: Ins<typeof core.attachments>;
  iterations: Ins<typeof core.iterations>;
  releases: Ins<typeof core.releases>;
  requirements: Ins<typeof core.requirements>;
  fieldValues: Ins<typeof core.fieldValues>;
  requirementAssignments: Ins<typeof core.requirementAssignments>;
  requirementRelations: Ins<typeof core.requirementRelations>;
  stateTransitions: Ins<typeof core.stateTransitions>;
  blockers: Ins<typeof core.blockers>;
  checkItemResults: Ins<typeof core.checkItemResults>;
  checkItemSignoffs: Ins<typeof core.checkItemSignoffs>;
  requirementReleases: Ins<typeof core.requirementReleases>;
  tasks: Ins<typeof core.tasks>;
  comments: Ins<typeof core.comments>;
  commentReads: Ins<typeof core.commentReads>;
  entityAliases: Ins<typeof core.entityAliases>;
  domainEvents: Ins<typeof core.domainEvents>;
  notificationChannels: Ins<typeof core.notificationChannels>;
  notificationSchedules: Ins<typeof core.notificationSchedules>;
  notificationDeliveries: Ins<typeof core.notificationDeliveries>;
};

export const INSERT_ORDER: Array<keyof ImportRows> = [
  'organizations', 'members', 'functionTags', 'memberFunctionTags', 'workflowDefinitions', 'workflowVersions', 'products',
  'productMembers', 'fieldDefinitions', 'fieldOptions', 'structureNodes', 'iterations', 'releases',
  'documentTemplates', 'documents', 'documentRevisions', 'attachments', 'requirements', 'fieldValues',
  'requirementAssignments', 'requirementRelations', 'stateTransitions', 'blockers', 'checkItemResults', 'checkItemSignoffs',
  'requirementReleases', 'tasks', 'comments', 'commentReads', 'entityAliases', 'domainEvents',
  'notificationChannels', 'notificationSchedules', 'notificationDeliveries',
];

export type ReconReport = {
  orgSlug: string;
  asOf: string;
  sourceCounts: Record<string, number>;
  targetCounts: Record<string, number>;
  people: Array<{ key: string; displayName: string; email: string | null; kind: 'human' | 'agent'; orgRole: string; hasAccount: boolean; mentions: number }>;
  /** 一个字段写了多人：单值字段取第一人，多值字段每人一条。 */
  personSplits: Array<{ raw: string; people: string[]; singleRefs: number; multiRefs: number }>;
  /** 一个成员的其他写法（别名，不含邮箱），供审阅合并是否正确。 */
  personMerges: Array<{ key: string; displayName: string; variants: string[] }>;
  /** 「代X by Y」写法，按实际操作人 Y 导入。 */
  proxies: Array<{ raw: string; refs: number }>;
  matching: {
    planeTotal: number;
    pushTotal: number;
    pushMergedSkipped: number;
    byPlaneId: number;
    byTitle: number;
    pushOnly: number;
    titleMatches: Array<{ displayKey: string; planeTitle: string; pushTitle: string }>;
  };
  conflicts: Array<{ displayKey: string; field: string; plane: string; push: string }>;
  iterations: Array<{ name: string; type: string; planeIds: string[]; pushIds: string[]; startDate: string; endDate: string; status: string; requirements: number }>;
  skipped: Array<{ what: string; count: number; reason: string }>;
  deferred: Array<{ what: string; count: number; phase: string }>;
  documents: {
    pages: number;
    revisions: number;
    attachments: number;
    inlineImages: number;
    comments: number;
    linkedRequirements: number;
    /** 关联的需求不在导入范围内（两个旧系统里都没有）：PRD 照常导入、不挂需求。 */
    unmatchedLinks: Array<{ document: string; requirement: string }>;
    /** 没有导入、正文与修订中换成「[图片未迁移]」的图片（内嵌图片与旧附件）：所在 PRD 与原因。 */
    droppedImages: Array<{ document: string; reason: string }>;
    /** 旧附件键为绝对路径或会跳出导出目录，不读取。 */
    invalidFileKeys: number;
    /** 导出目录里缺少的旧附件文件数；没给导出目录时为 null。 */
    missingFiles: number | null;
    externalImages: number;
    brokenImageRefs: number;
    external: {
      docs: number;
      requirements: number;
      shared: number;
      statusCounts: Record<string, number>;
      nonUrl: Array<{ displayKey: string; source: string; value: string }>;
      mismatches: Array<{ displayKey: string; plane: string; push: string }>;
      skippedNative: Array<{ displayKey: string; url: string }>;
      mergedOnly: number;
    };
    prdCheckChanges: Array<{ displayKey: string; document: string; from: string; to: string }>;
  };
  notifications: {
    channels: Array<{ source: string; name: string; kind: string; enabled: boolean }>;
    schedules: Array<{ source: string; name: string; kind: string; cron: string; enabled: boolean; channels: number }>;
    deliveries: number;
    skipped: Array<{ what: string; reason: string }>;
  };
  problems: string[];
};

export type ImportFile = { storageKey: string; from: { legacyKey: string } | { base64: string } };
export type ImportPlan = { rows: ImportRows; report: ReconReport; files: ImportFile[] };

export const emptyRows = (): ImportRows => Object.fromEntries(INSERT_ORDER.map((k) => [k, []])) as unknown as ImportRows;

export class PlanContext {
  readonly resolver: Resolver;
  readonly rows: ImportRows = emptyRows();
  readonly report: ReconReport;
  readonly orgId: string;
  readonly productId: string;
  readonly asOfTime: Date;
  readonly memberIdByKey = new Map<string, string>();
  readonly tagIdByName = new Map<string, string>();
  readonly fieldId = new Map<string, string>();
  readonly nodeIdByName = new Map<string, string>();
  readonly iterationIdByKey = new Map<string, string>();
  readonly releaseIdByPlaneId = new Map<string, string>();
  workflow!: core.WorkflowBody;
  /** 每条导入需求的来源（123plane 与 push 配对结果），外部 PRD 链接按它取原值。 */
  readonly requirementSources: Array<{ id: string; number: number; plane: PlaneRequirement | null; push: PushRequirement | null }> = [];
  /** 需要写进附件存储的文件。 */
  readonly files: ImportFile[] = [];

  constructor(
    readonly data: LegacyData,
    readonly mapping: Mapping,
    readonly opts: ImportOptions,
  ) {
    this.resolver = new Resolver(mapping);
    this.orgId = this.id('org', opts.orgSlug);
    this.productId = this.id('product', opts.productKey);
    this.asOfTime = new Date(`${opts.asOf}T00:00:00Z`);
    this.report = {
      orgSlug: opts.orgSlug,
      asOf: opts.asOf,
      sourceCounts: {},
      targetCounts: {},
      people: [],
      personSplits: [],
      personMerges: [],
      proxies: [],
      matching: { planeTotal: 0, pushTotal: 0, pushMergedSkipped: 0, byPlaneId: 0, byTitle: 0, pushOnly: 0, titleMatches: [] },
      conflicts: [],
      iterations: [],
      skipped: [],
      deferred: [],
      documents: {
        pages: 0,
        revisions: 0,
        attachments: 0,
        inlineImages: 0,
        comments: 0,
        linkedRequirements: 0,
        unmatchedLinks: [],
        droppedImages: [],
        invalidFileKeys: 0,
        missingFiles: opts.uploadsDir ? 0 : null,
        externalImages: 0,
        brokenImageRefs: 0,
        external: { docs: 0, requirements: 0, shared: 0, statusCounts: {}, nonUrl: [], mismatches: [], skippedNative: [], mergedOnly: 0 },
        prdCheckChanges: [],
      },
      notifications: { channels: [], schedules: [], deliveries: 0, skipped: [] },
      problems: [],
    };
  }

  id(ns: string, key: string): string {
    return legacyUuid(`${this.opts.orgSlug}/${ns}`, key);
  }

  /** 单值引用（需求负责人、提出人、任务负责人、事件操作人）：写了多人时取第一人，拆分记入报告。 */
  memberId(raw: string | null | undefined): string | null {
    const people = this.resolver.people(raw);
    if (people.length > 1) this.noteSplit(raw!, people, 'single');
    return people[0] ? (this.memberIdByKey.get(people[0].key) ?? null) : null;
  }

  /** 多值引用（开发分配、会签签字人）：写了多人时每人一个，拆分记入报告。 */
  memberIds(raw: string | null | undefined): string[] {
    const people = this.resolver.people(raw);
    if (people.length > 1) this.noteSplit(raw!, people, 'multi');
    return people.map((p) => this.memberIdByKey.get(p.key)).filter((id): id is string => !!id);
  }

  private noteSplit(raw: string, people: PersonEntry[], kind: 'single' | 'multi'): void {
    const key = raw.trim();
    let row = this.report.personSplits.find((s) => s.raw === key);
    if (!row) {
      row = { raw: key, people: people.map((p) => p.displayName), singleRefs: 0, multiRefs: 0 };
      this.report.personSplits.push(row);
    }
    if (kind === 'single') row.singleRefs += 1;
    else row.multiRefs += 1;
  }

  optionId(fieldKey: string, optionKey: string): string | null {
    const fieldId = this.fieldId.get(fieldKey);
    return this.rows.fieldOptions.find((o) => o.fieldId === fieldId && o.key === optionKey)?.id ?? null;
  }

  time(s: string | null | undefined, fallback?: Date): Date {
    return parseLegacyTime(s) ?? fallback ?? this.asOfTime;
  }

  problem(msg: string): void {
    if (!this.report.problems.includes(msg)) this.report.problems.push(msg);
  }
}
