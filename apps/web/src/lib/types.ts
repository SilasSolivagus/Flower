import type {
  AccountView,
  AttachmentView,
  CheckState as CoreCheckState,
  CommentView,
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
  IterationBrief as CoreIterationBrief,
  IterationDetail as CoreIterationDetail,
  IterationGantt as CoreIterationGantt,
  IterationMilestone as CoreIterationMilestone,
  IterationScope as CoreIterationScope,
  IterationView,
  MemberTask as CoreMemberTask,
  MemberTasks as CoreMemberTasks,
  MemberView,
  MyOrg as CoreMyOrg,
  OrgRole as CoreOrgRole,
  OrgView,
  ProductMemberRole as CoreProductMemberRole,
  ProductRole as CoreProductRole,
  ProductView,
  ReleaseView,
  RequirementDetail as CoreRequirementDetail,
  RequirementList as CoreRequirementList,
  RequirementListItem as CoreRequirementListItem,
  RevisionDiff as CoreRevisionDiff,
  RevisionListItem,
  ReviewFilterState as CoreReviewFilterState,
  ReviewQueue as CoreReviewQueue,
  ReviewState as CoreReviewState,
  StructureNodeView,
  TaskView,
  TemplateSection as CoreTemplateSection,
  TemplateView,
  TokenScope as CoreTokenScope,
  TokenView,
  Workbench as CoreWorkbench,
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
export type DocumentReviewQueue = Jsonify<CoreDocumentReviewQueue>;
export type Attachment = AttachmentView & { url: string };
