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
