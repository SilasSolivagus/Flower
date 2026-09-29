'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, api } from './api';
import type {
  Account,
  Field,
  FunctionTag,
  InstanceStatus,
  Iteration,
  IterationBrief,
  IterationDetail,
  IterationScope,
  Invitation,
  LevelNames,
  Member,
  MyOrg,
  Org,
  OrgMe,
  Product,
  ProductRole,
  RequirementComment,
  RequirementDetail,
  RequirementList,
  StructureNode,
  Token,
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
  productRoles: (o: string, id: string) => ['org', o, 'product', id, 'roles'] as const,
  productWorkflow: (o: string, id: string) => ['org', o, 'product', id, 'workflow'] as const,
  workflows: (o: string) => ['org', o, 'workflows'] as const,
  workflow: (o: string, id: string) => ['org', o, 'workflow', id] as const,
  fields: (o: string, productId?: string) => ['org', o, 'fields', productId ?? 'org'] as const,
  levels: (o: string, productId?: string) => ['org', o, 'levels', productId ?? 'org'] as const,
  tokens: (o: string) => ['org', o, 'tokens'] as const,
  requirements: (o: string, productId: string, query: string) => ['org', o, 'requirements', 'list', productId, query] as const,
  requirement: (o: string, key: string) => ['org', o, 'requirements', 'detail', key] as const,
  requirementComments: (o: string, id: string) => ['org', o, 'requirements', 'comments', id] as const,
  nodes: (o: string, productId: string) => ['org', o, 'product', productId, 'nodes'] as const,
  iterations: (o: string, productId: string) => ['org', o, 'iterations', 'product', productId] as const,
  iterationList: (o: string) => ['org', o, 'iterations', 'list'] as const,
  iteration: (o: string, id: string) => ['org', o, 'iterations', 'detail', id] as const,
  iterationScope: (o: string, id: string) => ['org', o, 'iterations', 'scope', id] as const,
};

export const useSetupStatus = () => useQuery({ queryKey: qk.setup, queryFn: () => api<InstanceStatus>('/setup/status') });
export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api<{ account: Account; orgs: MyOrg[] }>('/me') });
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
export const useFunctionTags = (o: string) =>
  useQuery({ queryKey: qk.tags(o), queryFn: () => api<{ tags: FunctionTag[] }>(`/orgs/${o}/function-tags`), select: (d) => d.tags });
export const useProducts = (o: string) =>
  useQuery({ queryKey: qk.products(o), queryFn: () => api<{ products: Product[] }>(`/orgs/${o}/products`), select: (d) => d.products });
export const useProduct = (o: string, id: string) =>
  useQuery({ queryKey: qk.product(o, id), queryFn: () => api<{ product: Product }>(`/orgs/${o}/products/${id}`), select: (d) => d.product });
export const useProductRoles = (o: string, id: string, enabled = true) =>
  useQuery({
    queryKey: qk.productRoles(o, id),
    queryFn: () => api<{ roles: Array<{ memberId: string; role: ProductRole }> }>(`/orgs/${o}/products/${id}/roles`),
    select: (d) => d.roles,
    enabled,
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
export const useFields = (o: string, productId?: string) =>
  useQuery({
    queryKey: qk.fields(o, productId),
    queryFn: () => api<{ fields: Field[] }>(`/orgs/${o}/fields${productId ? `?product=${productId}` : ''}`),
    select: (d) => d.fields,
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

export const useRequirements = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.requirements(o, productId ?? '', query),
    queryFn: () => api<RequirementList>(`/orgs/${o}/products/${productId}/requirements?${query}`),
    enabled: !!productId,
    placeholderData: keepPreviousData,
  });
export const useRequirement = (o: string, key: string) =>
  useQuery({
    queryKey: qk.requirement(o, key),
    queryFn: () => api<{ requirement: RequirementDetail }>(`/orgs/${o}/requirements/${encodeURIComponent(key)}`),
    select: (d) => d.requirement,
  });
export const useRequirementComments = (o: string, id: string | undefined) =>
  useQuery({
    queryKey: qk.requirementComments(o, id ?? ''),
    queryFn: () => api<{ comments: RequirementComment[] }>(`/orgs/${o}/requirements/${id}/comments`),
    select: (d) => d.comments,
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
