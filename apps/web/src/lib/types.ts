import type {
  AccountView,
  FieldOptionView,
  FieldView,
  FunctionTagView,
  InstanceStatus as CoreInstanceStatus,
  InvitationPreview as CoreInvitationPreview,
  InvitationView,
  MemberView,
  MyOrg as CoreMyOrg,
  OrgRole as CoreOrgRole,
  OrgView,
  ProductRole as CoreProductRole,
  ProductView,
  TokenScope as CoreTokenScope,
  TokenView,
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
