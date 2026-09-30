import type * as core from '@flower/core';
import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import { type Mapping, type PersonEntry, Resolver } from './mapping';
import { parseLegacyTime } from './normalize';

export type ImportOptions = {
  orgSlug: string;
  orgName: string;
  productKey: string;
  productName: string;
  asOf: string;
  owner: { accountId: string; email: string; name: string } | null;
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
};

export const INSERT_ORDER: Array<keyof ImportRows> = [
  'organizations', 'members', 'functionTags', 'memberFunctionTags', 'workflowDefinitions', 'workflowVersions', 'products',
  'productMembers', 'fieldDefinitions', 'fieldOptions', 'structureNodes', 'iterations', 'releases', 'requirements', 'fieldValues',
  'requirementAssignments', 'requirementRelations', 'stateTransitions', 'blockers', 'checkItemResults', 'checkItemSignoffs',
  'requirementReleases', 'tasks', 'comments', 'commentReads', 'entityAliases', 'domainEvents',
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
  problems: string[];
};

export type ImportPlan = { rows: ImportRows; report: ReconReport };

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
