export type ListFilter = {
  product: string | null;
  states: string[];
  node: string | null;
  priority: string[];
  platform: string[];
  owner: string | null;
  iteration: string | null;
  q: string;
  sort: 'updated' | 'number' | 'created';
  page: number;
};

export const EMPTY_FILTER: ListFilter = { product: null, states: [], node: null, priority: [], platform: [], owner: null, iteration: null, q: '', sort: 'updated', page: 1 };

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function parseFilter(sp: URLSearchParams): ListFilter {
  const sort = sp.get('sort');
  const page = Number.parseInt(sp.get('page') ?? '', 10);
  return {
    product: sp.get('product') || null,
    states: list(sp.get('state')),
    node: sp.get('node') || null,
    priority: list(sp.get('priority')),
    platform: list(sp.get('platform')),
    owner: sp.get('owner') || null,
    iteration: sp.get('iteration') || null,
    q: sp.get('q') ?? '',
    sort: sort === 'number' || sort === 'created' ? sort : 'updated',
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

export function filterToSearch(f: ListFilter): string {
  const sp = new URLSearchParams();
  if (f.product) sp.set('product', f.product);
  if (f.states.length) sp.set('state', f.states.join(','));
  if (f.node) sp.set('node', f.node);
  if (f.priority.length) sp.set('priority', f.priority.join(','));
  if (f.platform.length) sp.set('platform', f.platform.join(','));
  if (f.owner) sp.set('owner', f.owner);
  if (f.iteration) sp.set('iteration', f.iteration);
  if (f.q) sp.set('q', f.q);
  if (f.sort !== 'updated') sp.set('sort', f.sort);
  if (f.page > 1) sp.set('page', String(f.page));
  return sp.toString();
}

export function filterToApiQuery(f: ListFilter, pageSize = 50): string {
  const sp = new URLSearchParams();
  if (f.states.length) sp.set('state', f.states.join(','));
  if (f.node) sp.set('node', f.node);
  if (f.priority.length) sp.set('priority', f.priority.join(','));
  if (f.platform.length) sp.set('platform', f.platform.join(','));
  if (f.owner) sp.set('owner', f.owner);
  if (f.iteration === 'none') sp.set('noIteration', '1');
  else if (f.iteration) sp.set('iteration', f.iteration);
  if (f.q.trim()) sp.set('q', f.q.trim());
  sp.set('sort', f.sort);
  sp.set('page', String(f.page));
  sp.set('pageSize', String(pageSize));
  return sp.toString();
}

export function patchFilter(f: ListFilter, patch: Partial<ListFilter>): ListFilter {
  return { ...f, ...patch, page: patch.page ?? 1 };
}
