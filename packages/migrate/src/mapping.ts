import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aliasKey } from './normalize';

export type PersonEntry = {
  key: string;
  displayName: string;
  email: string | null;
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
  iterations: { iterations: IterationEntry[] };
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
  private readonly personByAlias = new Map<string, PersonEntry>();
  private readonly personByKey = new Map<string, PersonEntry>();
  private readonly domainByAlias = new Map<string, string>();
  private readonly iterationBySource = new Map<string, IterationEntry>();

  constructor(readonly mapping: Mapping) {
    for (const p of mapping.people.people) {
      this.personByKey.set(p.key, p);
      for (const a of [...p.aliases, p.displayName, ...(p.email ? [p.email] : [])]) this.personByAlias.set(aliasKey(a), p);
    }
    for (const n of mapping.domains.nodes) for (const a of [n.name, ...n.aliases]) this.domainByAlias.set(aliasKey(a), n.name);
    for (const it of mapping.iterations.iterations) {
      for (const id of it.planeIds) this.iterationBySource.set(`plane:${id}`, it);
      for (const id of it.pushIds) this.iterationBySource.set(`push:${id}`, it);
    }
  }

  person(raw: string | null | undefined): PersonEntry | null {
    const t = raw?.trim();
    if (!t) return null;
    const p = this.personByAlias.get(aliasKey(t));
    if (!p) this.unmapped.people.add(t);
    return p ?? null;
  }

  /** 与 person 相同的查找，但不记录未匹配值；用于"多个候选值，任一匹配即可"的场景，避免记录虚假的缺失项。 */
  personPeek(raw: string | null | undefined): PersonEntry | null {
    const t = raw?.trim();
    if (!t) return null;
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
    const it = this.iterationBySource.get(`${source}:${t}`);
    if (!it) this.unmapped.iterations.add(`${source}:${t}`);
    return it ?? null;
  }
}
