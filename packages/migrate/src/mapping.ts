import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aliasKey, splitNames } from './normalize';
import { parseProxySigner } from './workflow-v1';

export type PersonEntry = {
  key: string;
  displayName: string;
  email: string | null;
  /** 缺省为 human；工具、同步程序等建为 agent（成员 kind = agent）。 */
  kind?: 'human' | 'agent';
  /** 为 true 时 suggest 不拆分、不合并这一条（例如用户确认某个多人写法是一个小组）。 */
  keep?: boolean;
  orgRole: 'admin' | 'member' | 'guest';
  productRole: 'admin' | 'editor' | 'viewer' | null;
  functionTags: string[];
  aliases: string[];
  mentions: number;
};
export type IterationEntry = { key: string; name: string; type: 'regular' | 'special'; planeIds: string[]; pushIds: string[] };
export type Mapping = {
  people: { people: PersonEntry[]; signoffRoles: Record<string, string> };
  platforms: { options: Array<{ key: string; label: string }>; aliases: Record<string, string[]> };
  domains: { nodes: Array<{ name: string; description: string | null; aliases: string[] }> };
  iterations: { iterations: IterationEntry[]; ignore?: string[] };
};

export const MAPPING_FILES = { people: 'people.json', platforms: 'platforms.json', domains: 'domains.json', iterations: 'iterations.json' } as const;

export function readMapping(dir: string): Mapping | null {
  const files = Object.entries(MAPPING_FILES).map(([k, f]) => [k, path.join(dir, f)] as const);
  if (!files.every(([, p]) => existsSync(p))) return null;
  return Object.fromEntries(files.map(([k, p]) => [k, JSON.parse(readFileSync(p, 'utf8'))])) as Mapping;
}

export function writeMapping(dir: string, m: Mapping): void {
  mkdirSync(dir, { recursive: true });
  for (const [k, f] of Object.entries(MAPPING_FILES)) {
    writeFileSync(path.join(dir, f), `${JSON.stringify(m[k as keyof Mapping], null, 2)}\n`);
  }
}

export class Resolver {
  readonly unmapped = { people: new Set<string>(), platforms: new Set<string>(), domains: new Set<string>(), iterations: new Set<string>() };
  /** 导入时用到的、对照表里同时属于多个人的写法（例如两个同名的人）：不替任何一方做主，记为问题由用户在对照表里区分。 */
  readonly ambiguousPeople = new Set<string>();
  private readonly personByAlias = new Map<string, PersonEntry>();
  private readonly sharedAliases = new Set<string>();
  private readonly personByKey = new Map<string, PersonEntry>();
  private readonly domainByAlias = new Map<string, string>();
  private readonly iterationBySource = new Map<string, IterationEntry>();
  private readonly ignoredIterations: Set<string>;
  /** 命中 `iterations.ignore` 列表而被跳过的迭代引用次数（不计入 unmapped）。 */
  ignoredIterationRefs = 0;
  /** 「代X by Y」写法按实际操作人 Y 解析的次数（按原写法计），写入对账报告。 */
  readonly proxies = new Map<string, number>();

  constructor(readonly mapping: Mapping) {
    for (const p of mapping.people.people) {
      this.personByKey.set(p.key, p);
      for (const a of [...p.aliases, p.displayName, ...(p.email ? [p.email] : [])]) {
        const k = aliasKey(a);
        const prev = this.personByAlias.get(k);
        if (prev && prev !== p) this.sharedAliases.add(k);
        this.personByAlias.set(k, p);
      }
    }
    for (const n of mapping.domains.nodes) for (const a of [n.name, ...n.aliases]) this.domainByAlias.set(aliasKey(a), n.name);
    for (const it of mapping.iterations.iterations) {
      for (const id of it.planeIds) this.iterationBySource.set(`plane:${id}`, it);
      for (const id of it.pushIds) this.iterationBySource.set(`push:${id}`, it);
    }
    this.ignoredIterations = new Set(mapping.iterations.ignore ?? []);
  }

  /**
   * 一个原始写法对应的成员：整体是某人的写法时返回这个人；「代X by Y」取实际操作人 Y；
   * 否则按多人写法拆开逐个解析。未匹配的写法记入 unmapped。
   */
  people(raw: string | null | undefined): PersonEntry[] {
    const t = raw?.trim();
    if (!t) return [];
    if (this.sharedAliases.has(aliasKey(t))) {
      this.ambiguousPeople.add(t);
      return [];
    }
    const whole = this.personByAlias.get(aliasKey(t));
    if (whole) return [whole];
    const proxy = parseProxySigner(t);
    if (proxy) {
      this.proxies.set(t, (this.proxies.get(t) ?? 0) + 1);
      return this.people(proxy.actor);
    }
    const parts = splitNames(t);
    if (parts.length < 2) {
      this.unmapped.people.add(t);
      return [];
    }
    const out: PersonEntry[] = [];
    for (const part of parts) for (const p of this.people(part)) if (!out.includes(p)) out.push(p);
    return out;
  }

  /** 单个成员：写了多人时取第一人。需要记录拆分的地方用 PlanContext.memberId / memberIds。 */
  person(raw: string | null | undefined): PersonEntry | null {
    return this.people(raw)[0] ?? null;
  }

  /** 与 person 相同的查找，但不记录未匹配值；用于"多个候选值，任一匹配即可"的场景，避免记录虚假的缺失项。 */
  personPeek(raw: string | null | undefined): PersonEntry | null {
    const t = raw?.trim();
    if (!t || this.sharedAliases.has(aliasKey(t))) return null;
    return this.personByAlias.get(aliasKey(t)) ?? null;
  }

  personByMappingKey(key: string): PersonEntry | null {
    return this.personByKey.get(key) ?? null;
  }

  signoffRole(role: string): PersonEntry | null {
    const key = this.mapping.people.signoffRoles[role];
    const p = key ? this.personByKey.get(key) : undefined;
    if (!p) this.unmapped.people.add(`会签角色:${role}`);
    return p ?? null;
  }

  platforms(raw: string): string[] {
    const keys = this.mapping.platforms.aliases[aliasKey(raw)];
    if (!keys) {
      this.unmapped.platforms.add(raw);
      return [];
    }
    return keys;
  }

  domain(raw: string | null | undefined): string | null {
    const t = raw?.trim();
    if (!t) return null;
    const name = this.domainByAlias.get(aliasKey(t));
    if (!name) this.unmapped.domains.add(t);
    return name ?? null;
  }

  iteration(source: 'plane' | 'push', id: string | null | undefined): IterationEntry | null {
    const t = id?.trim();
    if (!t) return null;
    const key = `${source}:${t}`;
    if (this.ignoredIterations.has(key)) {
      this.ignoredIterationRefs += 1;
      return null;
    }
    const it = this.iterationBySource.get(key);
    if (!it) this.unmapped.iterations.add(key);
    return it ?? null;
  }
}
