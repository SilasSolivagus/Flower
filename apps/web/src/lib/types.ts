import type {
  AccountView,
  AffectedChangeType as CoreAffectedChangeType,
  AffectedNodes as CoreAffectedNodes,
  AttachmentView,
  BacklinkGroup as CoreBacklinkGroup,
  BacklinkTargetType as CoreBacklinkTargetType,
  ChannelOption as CoreChannelOption,
  ChannelView,
  CheckState as CoreCheckState,
  CommentView,
  DeliveryView,
  DocumentCommentView,
  DocumentDetail as CoreDocumentDetail,
  DocumentListItem as CoreDocumentListItem,
  DocumentReviewQueue as CoreDocumentReviewQueue,
  DocumentStatus as CoreDocumentStatus,
  ExternalProvider as CoreExternalProvider,
  FieldOptionView,
  FieldView,
  FunctionTagView,
  InstanceStatus as CoreInstanceStatus,
  InvitationPreview as CoreInvitationPreview,
  InvitationView,
  BriefConvertResult as CoreBriefConvertResult,
  BriefGate as CoreBriefGate,
  BriefListItem as CoreBriefListItem,
  BriefRelatedLink as CoreBriefRelatedLink,
  BriefStatus as CoreBriefStatus,
  IterationBrief as CoreIterationBrief,
  IterationDetail as CoreIterationDetail,
  IterationGantt as CoreIterationGantt,
  IterationMilestone as CoreIterationMilestone,
  IterationScope as CoreIterationScope,
  IterationView,
  LinkCard as CoreLinkCard,
  LinkSuggestion as CoreLinkSuggestion,
  MemberTask as CoreMemberTask,
  MemberTasks as CoreMemberTasks,
  MemberNotificationView,
  MemberView,
  MentionMember as CoreMentionMember,
  MergePlan as CoreMergePlan,
  MergeRecord as CoreMergeRecord,
  MergeResult as CoreMergeResult,
  MergeStatus as CoreMergeStatus,
  MessageTemplateView,
  ModuleDocumentTree as CoreModuleDocumentTree,
  MyOrg as CoreMyOrg,
  NotificationSettings as CoreNotificationSettings,
  OrgDashboard as CoreOrgDashboard,
  OrgRole as CoreOrgRole,
  OrgView,
  PersonalChannelSetting as CorePersonalChannelSetting,
  ProductDashboard as CoreProductDashboard,
  ProductMemberRole as CoreProductMemberRole,
  ProductRole as CoreProductRole,
  ProductView,
  ProgressView as CoreProgressView,
  ReleaseView,
  RequirementDetail as CoreRequirementDetail,
  RequirementTagView,
  WorkItemListItem as CoreWorkItemListItem,
  RequirementList as CoreRequirementList,
  RequirementListItem as CoreRequirementListItem,
  RequirementTracking as CoreRequirementTracking,
  RevisionDiff as CoreRevisionDiff,
  RevisionListItem,
  ReviewFilterState as CoreReviewFilterState,
  ReviewQueue as CoreReviewQueue,
  ReviewState as CoreReviewState,
  RuleView,
  RunResult as CoreRunResult,
  ScheduleView,
  StructureNodeView,
  SubscriptionView,
  TaskDetail as CoreTaskDetail,
  TaskView,
  TemplateKind as CoreTemplateKind,
  TemplateSection as CoreTemplateSection,
  TemplateView,
  TokenScope as CoreTokenScope,
  TokenView,
  TrackingList as CoreTrackingList,
  TrackingSettings as CoreTrackingSettings,
  Workbench as CoreWorkbench,
  WecomAppSettings as CoreWecomAppSettings,
  WecomImportResult as CoreWecomImportResult,
  WorkItemDetail as CoreWorkItemDetail,
  WorkflowBody as CoreWorkflowBody,
  WorkflowDefinitionView,
  WorkflowVersionView,
} from '@flower/core';

/** 接口返回的 JSON 中 Date 已序列化为字符串。 */
export type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type OrgRole = CoreOrgRole;
export type ProductRole = CoreProductRole;
export type TokenScope = CoreTokenScope;
export type WorkflowBody = CoreWorkflowBody;
export type Account = Jsonify<AccountView>;
export type InstanceStatus = CoreInstanceStatus;
export type MyOrg = CoreMyOrg;
export type Org = Jsonify<OrgView>;
export type OrgMe = { memberId: string; orgRole: OrgRole };
export type Member = Jsonify<MemberView>;
export type FunctionTag = FunctionTagView;
export type RequirementTag = RequirementTagView;
export type WorkItemListItem = Jsonify<CoreWorkItemListItem>;
export type Invitation = Jsonify<InvitationView>;
export type InvitationPreview = CoreInvitationPreview;
export type Token = Jsonify<TokenView>;
export type Product = Jsonify<ProductView>;
export type WorkflowDefinition = Jsonify<WorkflowDefinitionView>;
export type WorkflowVersion = Jsonify<WorkflowVersionView>;
export type Field = Jsonify<FieldView>;
export type FieldOption = Jsonify<FieldOptionView>;
export type LevelNames = { names: string[]; source: 'default' | 'org' | 'product' };
export type RequirementListItem = Jsonify<CoreRequirementListItem>;
export type RequirementList = Jsonify<CoreRequirementList>;
export type RequirementDetail = Jsonify<CoreRequirementDetail>;
export type RequirementComment = Jsonify<CommentView>;
export type StructureNode = StructureNodeView;
export type IterationBrief = CoreIterationBrief;
export type CheckState = CoreCheckState;
export type Iteration = Jsonify<IterationView>;
export type IterationMilestone = CoreIterationMilestone;
export type IterationDetail = Jsonify<CoreIterationDetail>;
export type IterationScope = Jsonify<CoreIterationScope>;
export type Release = Jsonify<ReleaseView>;
export type ProductMemberRole = CoreProductMemberRole;
export type Task = Jsonify<TaskView>;
export type IterationGantt = Jsonify<CoreIterationGantt>;
export type MemberTask = Jsonify<CoreMemberTask>;
export type MemberTasks = Jsonify<CoreMemberTasks>;
export type ReviewQueue = Jsonify<CoreReviewQueue>;
export type ReviewState = CoreReviewState;
export type ReviewFilterState = CoreReviewFilterState;
export type Workbench = Jsonify<CoreWorkbench>;
export type CheckItem = RequirementDetail['checkItems'][number];
export type DocumentStatus = CoreDocumentStatus;
export type ExternalProvider = CoreExternalProvider;
export type TemplateSection = CoreTemplateSection;
export type DocumentListItem = Jsonify<CoreDocumentListItem>;
export type DocumentDetail = Jsonify<CoreDocumentDetail>;
export type DocumentRevision = Jsonify<RevisionListItem>;
export type RevisionDiff = CoreRevisionDiff;
export type DocumentComment = Jsonify<DocumentCommentView>;
export type DocumentTemplate = Jsonify<TemplateView>;
export type TemplateKind = CoreTemplateKind;
export type BriefStatus = CoreBriefStatus;
export type BriefListItem = Jsonify<CoreBriefListItem>;
export type BriefGate = CoreBriefGate;
export type BriefRelatedLink = CoreBriefRelatedLink;
export type BriefConvertResult = Jsonify<CoreBriefConvertResult>;
export type DocumentReviewQueue = Jsonify<CoreDocumentReviewQueue>;
export type Attachment = AttachmentView & { url: string };
export type LinkCard = CoreLinkCard;
export type LinkSuggestion = CoreLinkSuggestion;
export type BacklinkTargetType = CoreBacklinkTargetType;
export type BacklinkGroup = Jsonify<CoreBacklinkGroup>;
export type TaskDetail = Jsonify<CoreTaskDetail>;
export type ModuleDocumentTree = Jsonify<CoreModuleDocumentTree>;
export type AffectedChangeType = CoreAffectedChangeType;
export type MergeStatus = CoreMergeStatus;
export type AffectedNodes = Jsonify<CoreAffectedNodes>;
export type AffectedNode = AffectedNodes['items'][number];
export type MergePlan = Jsonify<CoreMergePlan>;
export type MergeItem = MergePlan['groups'][number]['items'][number];
export type MergeResult = Jsonify<CoreMergeResult>;
export type MergeRecord = Jsonify<CoreMergeRecord>;

export type NotificationChannel = Jsonify<ChannelView>;
export type ChannelOption = CoreChannelOption;
export type MessageTemplate = Jsonify<MessageTemplateView>;
export type NotificationRule = Jsonify<RuleView>;
export type NotificationSchedule = Jsonify<ScheduleView>;
export type NotificationDelivery = Jsonify<DeliveryView>;
export type RunResult = CoreRunResult;

export type MemberNotification = Jsonify<MemberNotificationView>;
export type MentionMember = CoreMentionMember;
export type NotificationSettings = CoreNotificationSettings;
export type Subscription = SubscriptionView;
export type WecomAppSettings = Jsonify<CoreWecomAppSettings>;
export type WecomImportResult = CoreWecomImportResult;
export type WecomImportRow = WecomImportResult['rows'][number];
export type PersonalChannelSetting = CorePersonalChannelSetting;

export type ProductDashboard = Jsonify<CoreProductDashboard>;
export type OrgDashboard = Jsonify<CoreOrgDashboard>;
export type DashboardCards = ProductDashboard['cards'];

export type TrackingList = Jsonify<CoreTrackingList>;
export type TrackingItem = TrackingList['items'][number];
export type TrackingSettings = CoreTrackingSettings;
export type RequirementTracking = Jsonify<CoreRequirementTracking>;
export type WorkItemDetail = Jsonify<CoreWorkItemDetail>;
export type ProgressEntry = Jsonify<CoreProgressView>;
export type ProgressSubjectType = 'requirement' | 'work_item';
