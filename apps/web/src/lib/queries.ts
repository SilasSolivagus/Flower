'use client';

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, api } from './api';
import type {
  Account,
  AffectedNodes,
  BacklinkGroup,
  BacklinkTargetType,
  BriefGate,
  BriefListItem,
  ChannelOption,
  DocumentComment,
  DocumentDetail,
  DocumentListItem,
  DocumentReviewQueue,
  DocumentRevision,
  DocumentTemplate,
  Field,
  FunctionTag,
  InstanceStatus,
  Iteration,
  IterationBrief,
  IterationDetail,
  IterationGantt,
  IterationScope,
  Invitation,
  LevelNames,
  LinkCard,
  LinkSuggestion,
  Member,
  MemberNotification,
  MemberTasks,
  MentionMember,
  MergePlan,
  MergeRecord,
  MessageTemplate,
  ModuleDocumentTree,
  MyOrg,
  NotificationChannel,
  NotificationDelivery,
  NotificationRule,
  NotificationSchedule,
  NotificationSettings,
  Org,
  OrgDashboard,
  OrgMe,
  PersonalChannelSetting,
  Product,
  ProductDashboard,
  ProductMemberRole,
  ProgressEntry,
  ProgressSubjectType,
  Release,
  RequirementComment,
  RequirementDetail,
  RequirementList,
  RevisionDiff,
  ReviewQueue,
  StructureNode,
  Subscription,
  TaskDetail,
  TemplateKind,
  Token,
  TrackingList,
  TrackingSettings,
  WecomAppSettings,
  Workbench,
  WorkItemDetail,
  WorkflowDefinition,
  WorkflowVersion,
} from './types';

export const qk = {
  setup: ['setup'] as const,
  me: ['me'] as const,
  instance: ['instance'] as const,
  org: (o: string) => ['org', o] as const,
  members: (o: string) => ['org', o, 'members'] as const,
  invitations: (o: string) => ['org', o, 'invitations'] as const,
  tags: (o: string) => ['org', o, 'tags'] as const,
  products: (o: string) => ['org', o, 'products'] as const,
  product: (o: string, id: string) => ['org', o, 'product', id] as const,
  productMembers: (o: string, id: string) => ['org', o, 'product', id, 'members'] as const,
  productWorkflow: (o: string, id: string) => ['org', o, 'product', id, 'workflow'] as const,
  workflows: (o: string) => ['org', o, 'workflows'] as const,
  workflow: (o: string, id: string) => ['org', o, 'workflow', id] as const,
  fields: (o: string, productId?: string) => ['org', o, 'fields', productId ?? 'org'] as const,
  levels: (o: string, productId?: string) => ['org', o, 'levels', productId ?? 'org'] as const,
  tokens: (o: string) => ['org', o, 'tokens'] as const,
  requirements: (o: string, productId: string, query: string) => ['org', o, 'requirements', 'list', productId, query] as const,
  requirement: (o: string, key: string) => ['org', o, 'requirements', 'detail', key] as const,
  requirementComments: (o: string, id: string) => ['org', o, 'requirements', 'comments', id] as const,
  reviews: (o: string, productId: string, query: string) => ['org', o, 'requirements', 'reviews', productId, query] as const,
  productDashboard: (o: string, productId: string, query: string) => ['org', o, 'dashboard', 'product', productId, query] as const,
  orgDashboard: (o: string, query: string) => ['org', o, 'dashboard', 'org', query] as const,
  tracking: (o: string, query: string) => ['org', o, 'tracking', 'list', query] as const,
  trackingSettings: (o: string) => ['org', o, 'tracking', 'settings'] as const,
  workItem: (o: string, key: string) => ['org', o, 'tracking', 'work-item', key] as const,
  progress: (o: string, type: string, id: string) => ['org', o, 'tracking', 'progress', type, id] as const,
  nodes: (o: string, productId: string) => ['org', o, 'product', productId, 'nodes'] as const,
  iterations: (o: string, productId: string) => ['org', o, 'iterations', 'product', productId] as const,
  iterationList: (o: string) => ['org', o, 'iterations', 'list'] as const,
  iteration: (o: string, id: string) => ['org', o, 'iterations', 'detail', id] as const,
  iterationScope: (o: string, id: string) => ['org', o, 'iterations', 'scope', id] as const,
  gantt: (o: string, id: string) => ['org', o, 'iterations', 'gantt', id] as const,
  workbench: ['me', 'workbench'] as const,
  memberTasks: (o: string, memberId: string, all: boolean) => ['org', o, 'tasks', 'member', memberId, all ? 'all' : 'open'] as const,
  releases: (o: string, query: string) => ['org', o, 'releases', query] as const,
  documents: (o: string, productId: string, query: string) => ['org', o, 'documents', 'list', productId, query] as const,
  document: (o: string, key: string) => ['org', o, 'documents', 'detail', key] as const,
  documentRevisions: (o: string, id: string) => ['org', o, 'documents', 'revisions', id] as const,
  documentDiff: (o: string, id: string, from: number, to: number) => ['org', o, 'documents', 'diff', id, from, to] as const,
  documentComments: (o: string, id: string) => ['org', o, 'documents', 'comments', id] as const,
  documentReviews: (o: string, productId: string) => ['org', o, 'documents', 'reviews', productId] as const,
  moduleDocuments: (o: string, productId: string) => ['org', o, 'documents', 'modules', productId] as const,
  affectedNodes: (o: string, id: string) => ['org', o, 'documents', 'affected', id] as const,
  mergePlan: (o: string, id: string) => ['org', o, 'documents', 'merge', id] as const,
  mergeRecords: (o: string, id: string) => ['org', o, 'documents', 'merge-records', id] as const,
  briefs: (o: string, query: string) => ['org', o, 'briefs', 'list', query] as const,
  briefGate: (o: string, id: string) => ['org', o, 'briefs', 'gate', id] as const,
  templates: (o: string, scope: string) => ['org', o, 'templates', scope] as const,
  backlinks: (o: string, type: string, id: string) => ['org', o, 'links', 'backlinks', type, id] as const,
  documentLinks: (o: string, id: string) => ['org', o, 'links', 'document', id] as const,
  linkSearch: (o: string, productId: string, q: string) => ['org', o, 'links', 'search', productId, q] as const,
  task: (o: string, key: string) => ['org', o, 'tasks', 'detail', key] as const,
  notificationChannels: (o: string) => ['org', o, 'notify', 'channels'] as const,
  productChannels: (o: string, productId: string) => ['org', o, 'notify', 'product-channels', productId] as const,
  messageTemplates: (o: string) => ['org', o, 'notify', 'templates'] as const,
  notificationRules: (o: string, productId: string) => ['org', o, 'notify', 'rules', productId] as const,
  notificationSchedules: (o: string, productId: string) => ['org', o, 'notify', 'schedules', productId] as const,
  notificationDeliveries: (o: string, query: string) => ['org', o, 'notify', 'deliveries', query] as const,
  unreadCount: (o: string) => ['org', o, 'inbox', 'unread'] as const,
  notifications: (o: string, query: string) => ['org', o, 'inbox', 'list', query] as const,
  subscription: (o: string, type: string, id: string) => ['org', o, 'inbox', 'subscription', type, id] as const,
  notificationSettings: (o: string) => ['org', o, 'inbox', 'settings'] as const,
  mentionMembers: (o: string, productId: string) => ['org', o, 'mention-members', productId] as const,
  wecomApp: (o: string) => ['org', o, 'notify', 'wecom-app'] as const,
  personalChannel: (o: string, productId: string) => ['org', o, 'notify', 'personal-channel', productId] as const,
  personalEmailChannel: (o: string) => ['org', o, 'notify', 'personal-email-channel'] as const,
};

export const useSetupStatus = () => useQuery({ queryKey: qk.setup, queryFn: () => api<InstanceStatus>('/setup/status') });
export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api<{ account: Account; orgs: MyOrg[] }>('/me') });
export const useWorkbench = () =>
  useQuery({ queryKey: qk.workbench, queryFn: () => api<{ workbench: Workbench }>('/me/workbench'), select: (d) => d.workbench });
export const useInstanceSettings = () => useQuery({ queryKey: qk.instance, queryFn: () => api<InstanceStatus>('/instance/settings') });
export const useOrg = (o: string) =>
  useQuery({ queryKey: qk.org(o), queryFn: () => api<{ org: Org; me: OrgMe }>(`/orgs/${o}`) });
export const useMembers = (o: string, enabled = true) =>
  useQuery({ queryKey: qk.members(o), queryFn: () => api<{ members: Member[] }>(`/orgs/${o}/members`), select: (d) => d.members, enabled });
export const useInvitations = (o: string, enabled = true) =>
  useQuery({
    queryKey: qk.invitations(o),
    queryFn: () => api<{ invitations: Invitation[] }>(`/orgs/${o}/invitations`),
    select: (d) => d.invitations,
    enabled,
  });
export const useFunctionTags = (o: string, enabled = true) =>
  useQuery({ queryKey: qk.tags(o), queryFn: () => api<{ tags: FunctionTag[] }>(`/orgs/${o}/function-tags`), select: (d) => d.tags, enabled });
export const useProducts = (o: string) =>
  useQuery({ queryKey: qk.products(o), queryFn: () => api<{ products: Product[] }>(`/orgs/${o}/products`), select: (d) => d.products });
export const useProduct = (o: string, id: string) =>
  useQuery({ queryKey: qk.product(o, id), queryFn: () => api<{ product: Product }>(`/orgs/${o}/products/${id}`), select: (d) => d.product });
export const useProductMembers = (o: string, id: string) =>
  useQuery({
    queryKey: qk.productMembers(o, id),
    queryFn: () => api<{ members: ProductMemberRole[] }>(`/orgs/${o}/products/${id}/members`),
    select: (d) => d.members,
  });
export const useProductWorkflow = (o: string, id: string) =>
  useQuery({
    queryKey: qk.productWorkflow(o, id),
    queryFn: () => api<{ definition: WorkflowDefinition; version: WorkflowVersion }>(`/orgs/${o}/products/${id}/workflow`),
    enabled: !!id,
  });
export const useWorkflows = (o: string, enabled = true) =>
  useQuery({
    queryKey: qk.workflows(o),
    queryFn: () => api<{ workflows: WorkflowDefinition[] }>(`/orgs/${o}/workflows`),
    select: (d) => d.workflows,
    enabled,
  });
export const useWorkflow = (o: string, id: string) =>
  useQuery({
    queryKey: qk.workflow(o, id),
    queryFn: () => api<{ definition: WorkflowDefinition; versions: WorkflowVersion[] }>(`/orgs/${o}/workflows/${id}`),
  });
export const useFields = (o: string, productId?: string, enabled = true) =>
  useQuery({
    queryKey: qk.fields(o, productId),
    queryFn: () => api<{ fields: Field[] }>(`/orgs/${o}/fields${productId ? `?product=${productId}` : ''}`),
    select: (d) => d.fields,
    enabled,
  });
export const useLevelNames = (o: string, productId?: string) =>
  useQuery({
    queryKey: qk.levels(o, productId),
    queryFn: () => api<LevelNames>(productId ? `/orgs/${o}/products/${productId}/level-names` : `/orgs/${o}/level-names`),
  });
export const useTokens = (o: string) =>
  useQuery({ queryKey: qk.tokens(o), queryFn: () => api<{ tokens: Token[] }>(`/orgs/${o}/tokens`), select: (d) => d.tokens });

/** 需求相关查询的公共前缀：任何需求修改后统一失效。 */
export const requirementKeys = (o: string) => ['org', o, 'requirements'] as const;

/** 迭代相关查询的公共前缀：迭代或需求所属迭代变化后统一失效。 */
export const iterationKeys = (o: string) => ['org', o, 'iterations'] as const;

export const useIterations = (o: string) =>
  useQuery({ queryKey: qk.iterationList(o), queryFn: () => api<{ iterations: Iteration[] }>(`/orgs/${o}/iterations`), select: (d) => d.iterations });

export const useIteration = (o: string, id: string) =>
  useQuery({ queryKey: qk.iteration(o, id), queryFn: () => api<{ iteration: IterationDetail }>(`/orgs/${o}/iterations/${id}`), select: (d) => d.iteration });
export const useIterationScope = (o: string, id: string) =>
  useQuery({ queryKey: qk.iterationScope(o, id), queryFn: () => api<{ scope: IterationScope }>(`/orgs/${o}/iterations/${id}/scope`), select: (d) => d.scope });

/** 按人查看任务的公共前缀。 */
export const taskKeys = (o: string) => ['org', o, 'tasks'] as const;

/** 任务修改后要刷新的查询：迭代（含甘特）、需求（详情里的任务）、按人任务、工作台。 */
export const taskMutationKeys = (o: string) => [iterationKeys(o), requirementKeys(o), taskKeys(o), qk.workbench];

export const useIterationGantt = (o: string, id: string) =>
  useQuery({ queryKey: qk.gantt(o, id), queryFn: () => api<{ gantt: IterationGantt }>(`/orgs/${o}/iterations/${id}/gantt`), select: (d) => d.gantt });

export const useMemberTasks = (o: string, memberId: string, all: boolean) =>
  useQuery({
    queryKey: qk.memberTasks(o, memberId, all),
    queryFn: () => api<MemberTasks>(`/orgs/${o}/members/${memberId}/tasks${all ? '?all=1' : ''}`),
    enabled: !!memberId,
  });

/** 发布版本查询的公共前缀。 */
export const releaseKeys = (o: string) => ['org', o, 'releases'] as const;

export const useReleases = (o: string, query: string, enabled = true) =>
  useQuery({ queryKey: qk.releases(o, query), queryFn: () => api<{ releases: Release[] }>(`/orgs/${o}/releases?${query}`), select: (d) => d.releases, enabled });

export const useRequirements = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.requirements(o, productId ?? '', query),
    queryFn: () => api<RequirementList>(`/orgs/${o}/products/${productId}/requirements?${query}`),
    enabled: !!productId,
    placeholderData: keepPreviousData,
  });
export const useRequirement = (o: string, key: string, enabled = true) =>
  useQuery({
    queryKey: qk.requirement(o, key),
    queryFn: () => api<{ requirement: RequirementDetail }>(`/orgs/${o}/requirements/${encodeURIComponent(key)}`),
    select: (d) => d.requirement,
    enabled,
  });
export const useRequirementComments = (o: string, id: string | undefined) =>
  useQuery({
    queryKey: qk.requirementComments(o, id ?? ''),
    queryFn: () => api<{ comments: RequirementComment[] }>(`/orgs/${o}/requirements/${id}/comments`),
    select: (d) => d.comments,
    enabled: !!id,
  });
export const useReviewQueue = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.reviews(o, productId ?? '', query),
    queryFn: () => api<{ queue: ReviewQueue }>(`/orgs/${o}/products/${productId}/reviews?${query}`),
    select: (d) => d.queue,
    enabled: !!productId,
    placeholderData: keepPreviousData,
  });

/** 看板打开时实时计算，前端缓存 5 分钟；切换筛选时保留上一次结果，避免闪烁。 */
const DASHBOARD_STALE_MS = 5 * 60_000;

export const useProductDashboard = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.productDashboard(o, productId ?? '', query),
    queryFn: () => api<{ dashboard: ProductDashboard }>(`/orgs/${o}/products/${productId}/dashboard${query ? `?${query}` : ''}`),
    select: (d) => d.dashboard,
    enabled: !!productId,
    staleTime: DASHBOARD_STALE_MS,
    placeholderData: keepPreviousData,
  });

export const useOrgDashboard = (o: string, query: string) =>
  useQuery({
    queryKey: qk.orgDashboard(o, query),
    queryFn: () => api<{ dashboard: OrgDashboard }>(`/orgs/${o}/dashboard${query ? `?${query}` : ''}`),
    select: (d) => d.dashboard,
    staleTime: DASHBOARD_STALE_MS,
    placeholderData: keepPreviousData,
  });

/** 跟进相关查询的公共前缀：需求跟进设置、工作项、进展记录、阈值变化后统一失效。 */
export const trackingKeys = (o: string) => ['org', o, 'tracking'] as const;

export const useTracking = (o: string, query: string) =>
  useQuery({
    queryKey: qk.tracking(o, query),
    queryFn: () => api<{ tracking: TrackingList }>(`/orgs/${o}/tracking${query ? `?${query}` : ''}`),
    select: (d) => d.tracking,
    placeholderData: keepPreviousData,
  });

export const useTrackingSettings = (o: string) =>
  useQuery({ queryKey: qk.trackingSettings(o), queryFn: () => api<{ settings: TrackingSettings }>(`/orgs/${o}/tracking-settings`), select: (d) => d.settings });

export const useWorkItem = (o: string, key: string) =>
  useQuery({ queryKey: qk.workItem(o, key), queryFn: () => api<{ workItem: WorkItemDetail }>(`/orgs/${o}/work-items/${encodeURIComponent(key)}`), select: (d) => d.workItem });

export const useProgress = (o: string, type: ProgressSubjectType, id: string | undefined) =>
  useQuery({
    queryKey: qk.progress(o, type, id ?? ''),
    queryFn: () => api<{ progress: ProgressEntry[] }>(`/orgs/${o}/${type === 'requirement' ? 'requirements' : 'work-items'}/${id}/progress`),
    select: (d) => d.progress,
    enabled: !!id,
  });

export const useNodes = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.nodes(o, productId ?? ''),
    queryFn: () => api<{ nodes: StructureNode[] }>(`/orgs/${o}/products/${productId}/nodes`),
    select: (d) => d.nodes,
    enabled: !!productId,
  });
export const useProductIterations = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.iterations(o, productId ?? ''),
    queryFn: () => api<{ iterations: IterationBrief[] }>(`/orgs/${o}/products/${productId}/iterations`),
    select: (d) => d.iterations,
    enabled: !!productId,
  });

/** PRD 相关查询的公共前缀：PRD、修订、评论、检查项变化后统一失效。 */
export const documentKeys = (o: string) => ['org', o, 'documents'] as const;
export const templateKeys = (o: string) => ['org', o, 'templates'] as const;

/** 简报列表与闸口的公共前缀：正文保存、头部、覆盖需求、勾选与转 PRD 之后统一失效。 */
export const briefKeys = (o: string) => ['org', o, 'briefs'] as const;
export const useBriefs = (o: string, query: string, enabled = true) =>
  useQuery({ queryKey: qk.briefs(o, query), queryFn: () => api<{ briefs: BriefListItem[] }>(`/orgs/${o}/briefs?${query}`), select: (d) => d.briefs, enabled });
export const useBriefGate = (o: string, id: string) =>
  useQuery({ queryKey: qk.briefGate(o, id), queryFn: () => api<{ gate: BriefGate }>(`/orgs/${o}/briefs/${id}/gate`), select: (d) => d.gate });

export const useDocuments = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.documents(o, productId ?? '', query),
    queryFn: () => api<{ documents: DocumentListItem[] }>(`/orgs/${o}/products/${productId}/documents?${query}`),
    select: (d) => d.documents,
    enabled: !!productId,
    placeholderData: keepPreviousData,
  });
export const useDocument = (o: string, key: string) =>
  useQuery({ queryKey: qk.document(o, key), queryFn: () => api<{ document: DocumentDetail }>(`/orgs/${o}/documents/${encodeURIComponent(key)}`), select: (d) => d.document });
export const useDocumentRevisions = (o: string, id: string, enabled = true) =>
  useQuery({
    queryKey: qk.documentRevisions(o, id),
    queryFn: () => api<{ revisions: DocumentRevision[] }>(`/orgs/${o}/documents/${id}/revisions`),
    select: (d) => d.revisions,
    enabled,
  });
export const useDocumentDiff = (o: string, id: string, from: number, to: number) =>
  useQuery({
    queryKey: qk.documentDiff(o, id, from, to),
    queryFn: () => api<{ diff: RevisionDiff }>(`/orgs/${o}/documents/${id}/diff?from=${from}&to=${to}`),
    select: (d) => d.diff,
    enabled: from > 0 && to > 0 && from !== to,
  });
export const useDocumentComments = (o: string, id: string) =>
  useQuery({ queryKey: qk.documentComments(o, id), queryFn: () => api<{ comments: DocumentComment[] }>(`/orgs/${o}/documents/${id}/comments`), select: (d) => d.comments });
export const useDocumentReviews = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.documentReviews(o, productId ?? ''),
    queryFn: () => api<{ queue: DocumentReviewQueue }>(`/orgs/${o}/products/${productId}/document-reviews`),
    select: (d) => d.queue,
    enabled: !!productId,
  });
export const useModuleDocuments = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.moduleDocuments(o, productId ?? ''),
    queryFn: () => api<{ tree: ModuleDocumentTree }>(`/orgs/${o}/products/${productId}/module-documents`),
    select: (d) => d.tree,
    enabled: !!productId,
  });
export const useAffectedNodes = (o: string, id: string) =>
  useQuery({ queryKey: qk.affectedNodes(o, id), queryFn: () => api<{ affected: AffectedNodes }>(`/orgs/${o}/documents/${id}/affected-nodes`), select: (d) => d.affected });
export const useMergePlan = (o: string, id: string | undefined) =>
  useQuery({
    queryKey: qk.mergePlan(o, id ?? ''),
    queryFn: () => api<{ plan: MergePlan }>(`/orgs/${o}/documents/${id}/merge`),
    select: (d) => d.plan,
    enabled: !!id,
  });
export const useMergeRecords = (o: string, id: string) =>
  useQuery({ queryKey: qk.mergeRecords(o, id), queryFn: () => api<{ records: MergeRecord[] }>(`/orgs/${o}/documents/${id}/merge-records`), select: (d) => d.records });
export const useTemplates = (o: string, opts: { productId?: string; usable?: boolean; kind?: TemplateKind }, enabled = true) =>
  useQuery({
    queryKey: qk.templates(o, `${opts.productId ?? 'org'}:${opts.usable ? 'usable' : 'all'}:${opts.kind ?? 'change'}`),
    queryFn: () =>
      api<{ templates: DocumentTemplate[] }>(
        `/orgs/${o}/templates?${new URLSearchParams({ ...(opts.productId ? { product: opts.productId } : {}), ...(opts.usable ? { usable: '1' } : {}), kind: opts.kind ?? 'change' })}`,
      ),
    select: (d) => d.templates,
    enabled,
  });

/** 链接相关查询的公共前缀：需求描述、PRD 正文、评论保存后统一失效（链接卡、「被引用」、补全）。 */
export const linkKeys = (o: string) => ['org', o, 'links'] as const;

export const useBacklinks = (o: string, type: BacklinkTargetType, id: string) =>
  useQuery({
    queryKey: qk.backlinks(o, type, id),
    queryFn: () => api<{ groups: BacklinkGroup[] }>(`/orgs/${o}/backlinks?${new URLSearchParams({ type, id })}`),
    select: (d) => d.groups,
  });
export const useDocumentLinks = (o: string, id: string) =>
  useQuery({ queryKey: qk.documentLinks(o, id), queryFn: () => api<{ cards: LinkCard[] }>(`/orgs/${o}/documents/${id}/links`), select: (d) => d.cards });
export const useLinkSearch = (o: string, productId: string, q: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.linkSearch(o, productId, q.trim()),
    queryFn: () => api<{ suggestions: LinkSuggestion[] }>(`/orgs/${o}/links/search?${new URLSearchParams({ product: productId, q: q.trim() })}`),
    select: (d) => d.suggestions,
    enabled,
    placeholderData: keepPreviousData,
  });
export const useTask = (o: string, key: string) =>
  useQuery({ queryKey: qk.task(o, key), queryFn: () => api<{ task: TaskDetail }>(`/orgs/${o}/tasks/${encodeURIComponent(key)}`), select: (d) => d.task });

/** 推送相关查询的公共前缀：通道、模板、规则、定时推送或发送记录变化后统一失效。 */
export const notifyKeys = (o: string) => ['org', o, 'notify'] as const;

export const useNotificationChannels = (o: string) =>
  useQuery({ queryKey: qk.notificationChannels(o), queryFn: () => api<{ channels: NotificationChannel[] }>(`/orgs/${o}/notification-channels`), select: (d) => d.channels });
export const useProductChannels = (o: string, productId: string) =>
  useQuery({
    queryKey: qk.productChannels(o, productId),
    queryFn: () => api<{ channels: ChannelOption[] }>(`/orgs/${o}/products/${productId}/notification-channels`),
    select: (d) => d.channels,
    enabled: !!productId,
  });
export const useMessageTemplates = (o: string) =>
  useQuery({ queryKey: qk.messageTemplates(o), queryFn: () => api<{ templates: MessageTemplate[] }>(`/orgs/${o}/message-templates`), select: (d) => d.templates });
export const useNotificationRules = (o: string, productId: string) =>
  useQuery({
    queryKey: qk.notificationRules(o, productId),
    queryFn: () => api<{ rules: NotificationRule[] }>(`/orgs/${o}/products/${productId}/notification-rules`),
    select: (d) => d.rules,
  });
/** productId 为空时列出全部（组织管理员）。 */
export const useNotificationSchedules = (o: string, productId?: string) =>
  useQuery({
    queryKey: qk.notificationSchedules(o, productId ?? ''),
    queryFn: () => api<{ schedules: NotificationSchedule[] }>(`/orgs/${o}/notification-schedules${productId ? `?product=${productId}` : ''}`),
    select: (d) => d.schedules,
  });
export const useNotificationDeliveries = (o: string, query: string) =>
  useQuery({
    queryKey: qk.notificationDeliveries(o, query),
    queryFn: () => api<{ deliveries: NotificationDelivery[]; nextCursor: string | null }>(`/orgs/${o}/notification-deliveries${query ? `?${query}` : ''}`),
    placeholderData: keepPreviousData,
  });

type MutationOptions<TData, TVars> = {
  invalidate?: ReadonlyArray<readonly unknown[]>;
  success?: string;
  /** 为 true 时不弹出错误提示，由表单自己展示 mutation.error。 */
  silentError?: boolean;
  onSuccess?: (data: TData, vars: TVars) => void;
};

export function useApiMutation<TVars, TData = unknown>(fn: (vars: TVars) => Promise<TData>, opts: MutationOptions<TData, TVars> = {}) {
  const qc = useQueryClient();
  return useMutation<TData, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: async (data, vars) => {
      await Promise.all((opts.invalidate ?? []).map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (opts.success) toast.success(opts.success);
      opts.onSuccess?.(data, vars);
    },
    onError: (e) => {
      if (!opts.silentError) toast.error(e.message || '操作失败，请稍后重试');
    },
  });
}

/** 站内通知相关查询的公共前缀：标已读、关注、偏好变化后统一失效。 */
export const inboxKeys = (o: string) => ['org', o, 'inbox'] as const;

export const useUnreadCount = (o: string) =>
  useQuery({ queryKey: qk.unreadCount(o), queryFn: () => api<{ count: number }>(`/orgs/${o}/notifications/unread-count`), select: (d) => d.count, refetchInterval: 30_000 });
export const useNotifications = (o: string, query: string, enabled = true) =>
  useQuery({
    queryKey: qk.notifications(o, query),
    queryFn: () => api<{ notifications: MemberNotification[]; nextCursor: string | null }>(`/orgs/${o}/notifications?${query}`),
    select: (d) => d.notifications,
    enabled,
    placeholderData: keepPreviousData,
  });
/** 通知页：按游标逐页加载。 */
export const useNotificationPages = (o: string, query: string) =>
  useInfiniteQuery({
    queryKey: [...qk.notifications(o, query), 'pages'],
    queryFn: ({ pageParam }) =>
      api<{ notifications: MemberNotification[]; nextCursor: string | null }>(`/orgs/${o}/notifications?${query}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
export const useSubscription = (o: string, type: 'requirement' | 'document' | 'work_item', id: string | undefined) =>
  useQuery({
    queryKey: qk.subscription(o, type, id ?? ''),
    queryFn: () => api<{ subscription: Subscription }>(`/orgs/${o}/subscriptions/${type}/${id}`),
    select: (d) => d.subscription,
    enabled: !!id,
  });
export const useNotificationSettings = (o: string) =>
  useQuery({ queryKey: qk.notificationSettings(o), queryFn: () => api<{ settings: NotificationSettings }>(`/orgs/${o}/me/notification-settings`), select: (d) => d.settings });
/** @ 补全与成员标签用的成员列表；productId 为 null 时取组织级（不关联产品的工作项），为 undefined 时不请求。 */
export const useMentionMembers = (o: string, productId: string | null | undefined) =>
  useQuery({
    queryKey: qk.mentionMembers(o, productId ?? 'org'),
    queryFn: () => api<{ members: MentionMember[] }>(productId ? `/orgs/${o}/products/${productId}/mention-members` : `/orgs/${o}/mention-members`),
    select: (d) => d.members,
    enabled: productId !== undefined,
    staleTime: 60_000,
  });
export const useWecomApp = (o: string) => useQuery({ queryKey: qk.wecomApp(o), queryFn: () => api<{ settings: WecomAppSettings }>(`/orgs/${o}/wecom-app`), select: (d) => d.settings });
export const usePersonalChannel = (o: string, productId: string) =>
  useQuery({ queryKey: qk.personalChannel(o, productId), queryFn: () => api<PersonalChannelSetting>(`/orgs/${o}/products/${productId}/personal-channel`), enabled: !!productId });
export const usePersonalEmailChannel = (o: string) => useQuery({ queryKey: qk.personalEmailChannel(o), queryFn: () => api<PersonalChannelSetting>(`/orgs/${o}/personal-email-channel`) });
