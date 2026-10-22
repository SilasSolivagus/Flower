export type WorkItemListFilter = {
  product: string | null;
  owner: string | null;
  paused: boolean;
  blocked: boolean;
  done: boolean;
  canceled: boolean;
};

export const EMPTY_WORK_ITEM_FILTER: WorkItemListFilter = {
  product: null,
  owner: null,
  paused: false,
  blocked: false,
  done: false,
  canceled: false,
};

/** 地址栏 → 工作项列表筛选。格式不对的 UUID 原样交给接口。 */
export function workItemFilterFromParams(params: URLSearchParams): WorkItemListFilter {
  return {
    product: params.get('product') || null,
    owner: params.get('owner') || null,
    paused: params.get('paused') === '1',
    blocked: params.get('blocked') === '1',
    done: params.get('done') === '1',
    canceled: params.get('canceled') === '1',
  };
}

export function workItemListQuery(f: WorkItemListFilter): string {
  const p = new URLSearchParams();
  if (f.product) p.set('product', f.product);
  if (f.owner) p.set('owner', f.owner);
  if (f.paused) p.set('paused', '1');
  if (f.blocked) p.set('blocked', '1');
  if (f.done) p.set('done', '1');
  if (f.canceled) p.set('canceled', '1');
  return p.toString();
}

export function workItemsHref(org: string, f: WorkItemListFilter): string {
  const q = workItemListQuery(f);
  return `/${org}/work-items${q ? `?${q}` : ''}`;
}
