import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import type { IterationEntry, Mapping, PersonEntry } from './mapping';
import { aliasKey, parseJsonArray, parseLegacyDate, splitNames, splitPlatforms } from './normalize';
import { BOSS_ROLE, DEFAULT_PLATFORM_OPTIONS, KNOWN_PLATFORM_ALIASES, parseProxySigner, SIGNOFF_ROLE_TAG } from './workflow-v1';

type Mention = { raw: string; email: string | null; role: 'owner' | 'developer' | 'requester' | 'signer' | 'other'; signoffRole?: string };

export function collectPersonMentions(data: LegacyData): Mention[] {
  const out: Mention[] = [];
  const add = (raw: string | null | undefined, role: Mention['role'], email: string | null = null, signoffRole?: string) => {
    const t = raw?.trim();
    if (t) out.push({ raw: t, email, role, signoffRole });
  };
  const { plane, push, prd } = data;
  for (const u of plane.users) add(u.name, 'other', u.email.trim().toLowerCase());
  for (const u of prd.users) add(u.name, 'other', u.email.trim().toLowerCase());
  for (const r of plane.requirements) {
    splitNames(r.requester).forEach((n) => add(n, 'requester'));
    splitNames(r.owner).forEach((n) => add(n, 'owner'));
  }
  for (const d of plane.requirementDevelopers) add(d.developer, 'developer');
  for (const s of plane.subtasks) add(s.assignee, 'developer');
  for (const c of plane.comments) add(c.user_name, 'other', c.user_email?.trim().toLowerCase() ?? null);
  for (const c of plane.commentReads) add(c.user_email, 'other', c.user_email.trim().toLowerCase());
  for (const a of plane.activityLog) add(a.user_email, 'other', a.user_email?.includes('@') ? a.user_email.trim().toLowerCase() : null);
  for (const b of plane.blockers) {
    add(b.created_by, 'other');
    add(b.resolved_by, 'other');
  }
  for (const u of plane.requirementUpdates) add(u.created_by, 'other');
  for (const l of plane.iterationLogs) add(l.created_by, 'other');
  for (const r of push.requirements) {
    splitNames(r.requester).forEach((n) => add(n, 'requester'));
    splitNames(r.owner).forEach((n) => add(n, 'owner'));
    add(r.last_edited_by, 'other');
  }
  for (const g of push.ganttTasks) {
    add(g.assignee, 'developer');
    add(g.ov_assignee, 'developer');
  }
  for (const s of push.designSignoffs) {
    if (!s.by) continue;
    const proxy = parseProxySigner(s.by);
    if (proxy) {
      add(proxy.onBehalfOf, 'signer', null, proxy.onBehalfOf);
      add(proxy.actor, 'signer', null, s.role);
    } else add(s.by, 'signer', null, s.role);
  }
  for (const r of push.prdReviews) for (const by of [r.e1_by, r.e2_by, r.e3_by, r.submitted_by]) add(by, 'other');
  for (const c of push.changeLog) add(c.edited_by, 'other');
  for (const a of push.autoReviews) add(a.reviewed_by, 'other');
  return out;
}

const localPart = (email: string) => email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9_]/g, '_');

function suggestPeople(data: LegacyData, existing: Mapping['people'] | null): Mapping['people'] {
  const people: PersonEntry[] = existing ? existing.people.map((p) => ({ ...p })) : [];
  const byAlias = new Map<string, PersonEntry>();
  const index = (p: PersonEntry) => {
    for (const a of [...p.aliases, p.displayName, ...(p.email ? [p.email] : [])]) byAlias.set(aliasKey(a), p);
  };
  people.forEach(index);
  const nameToEmail = new Map<string, string>();
  for (const u of [...data.plane.users, ...data.prd.users]) nameToEmail.set(aliasKey(u.name), u.email.trim().toLowerCase());
  const planeUser = new Map(data.plane.users.map((u) => [u.email.trim().toLowerCase(), u]));
  const usedKeys = new Set(people.map((p) => p.key));
  const uniqueKey = (base: string) => {
    let k = base;
    for (let i = 2; usedKeys.has(k); i++) k = `${base}_${i}`;
    usedKeys.add(k);
    return k;
  };
  const fresh = new Set<PersonEntry>();
  const signoffRoles: Record<string, string> = { ...(existing?.signoffRoles ?? {}) };

  for (const m of collectPersonMentions(data)) {
    if (m.signoffRole === BOSS_ROLE && m.raw === BOSS_ROLE) {
      if (!signoffRoles[BOSS_ROLE]) {
        const p = byAlias.get(aliasKey(BOSS_ROLE)) ?? addPerson(BOSS_ROLE, null);
        signoffRoles[BOSS_ROLE] = p.key;
      }
      continue;
    }
    const email = m.email ?? nameToEmail.get(aliasKey(m.raw)) ?? null;
    let p = byAlias.get(aliasKey(m.raw)) ?? (email ? byAlias.get(aliasKey(email)) : undefined);
    if (!p) p = addPerson(m.raw.includes('@') ? m.raw.split('@')[0]! : m.raw, email);
    if (!p.aliases.some((a) => aliasKey(a) === aliasKey(m.raw))) {
      p.aliases.push(m.raw);
      index(p);
    }
    if (fresh.has(p)) {
      p.mentions += 1;
      const tag =
        m.role === 'owner' ? '产品经理' : m.role === 'developer' ? '开发' : m.role === 'signer' && m.signoffRole ? SIGNOFF_ROLE_TAG[m.signoffRole] : undefined;
      if (tag && !p.functionTags.includes(tag)) p.functionTags.push(tag);
    }
  }

  function addPerson(name: string, email: string | null): PersonEntry {
    const user = email ? planeUser.get(email) : undefined;
    const p: PersonEntry = {
      key: uniqueKey(email ? `p_${localPart(email)}` : `p_${legacyUuid('person', name).slice(0, 8)}`),
      displayName: user?.name ?? name,
      email,
      orgRole: user?.role === 'admin' ? 'admin' : 'member',
      productRole: user?.role === 'viewer' ? 'viewer' : null,
      functionTags: [],
      aliases: [name, ...(user?.nickname ? [user.nickname] : [])],
      mentions: 0,
    };
    people.push(p);
    fresh.add(p);
    index(p);
    return p;
  }

  for (const p of fresh) p.functionTags.sort();
  return { people, signoffRoles };
}

function suggestPlatforms(data: LegacyData, existing: Mapping['platforms'] | null): Mapping['platforms'] {
  const options = existing ? [...existing.options] : [...DEFAULT_PLATFORM_OPTIONS];
  const aliases: Record<string, string[]> = { ...(existing?.aliases ?? {}) };
  const raws = [
    ...data.plane.requirements.flatMap((r) => splitPlatforms(r.platform)),
    ...data.plane.requirementDevelopers.map((d) => d.platform ?? ''),
    ...data.plane.versions.map((v) => v.platform ?? ''),
    ...data.push.requirements.flatMap((r) => parseJsonArray(r.platforms)),
  ].filter(Boolean);
  for (const raw of raws) {
    const k = aliasKey(raw);
    if (aliases[k]) continue;
    const known = KNOWN_PLATFORM_ALIASES[k];
    if (known) {
      aliases[k] = known;
      continue;
    }
    const key = `x_${legacyUuid('platform', k).replace(/-/g, '').slice(0, 6)}`;
    if (!options.some((o) => o.key === key)) options.push({ key, label: raw.trim() });
    aliases[k] = [key];
  }
  return { options, aliases };
}

function suggestDomains(data: LegacyData, existing: Mapping['domains'] | null): Mapping['domains'] {
  const nodes = existing ? existing.nodes.map((n) => ({ ...n, aliases: [...n.aliases] })) : [];
  const known = new Set(nodes.flatMap((n) => [n.name, ...n.aliases]).map(aliasKey));
  const push = (name: string, description: string | null) => {
    const t = name.trim();
    if (!t || known.has(aliasKey(t))) return;
    known.add(aliasKey(t));
    nodes.push({ name: t, description, aliases: [t] });
  };
  for (const d of data.prd.domains) push(d.name, [d.type, d.group].filter(Boolean).join(' · ') || null);
  const freq = new Map<string, number>();
  for (const r of data.plane.requirements) {
    const t = r.business_domain?.trim();
    if (t) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  for (const [name] of [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))) push(name, null);
  return { nodes };
}

export function iterationWindow(entry: Pick<IterationEntry, 'planeIds' | 'pushIds'>, data: LegacyData): { start: string; end: string } | null {
  const plane = data.plane.iterations.find((i) => entry.planeIds.includes(i.id));
  const push = data.push.versions.find((v) => entry.pushIds.includes(v.id));
  const start = parseLegacyDate(plane?.kickoff_date) ?? parseLegacyDate(plane?.dev_start) ?? parseLegacyDate(push?.start_date);
  const end = parseLegacyDate(push?.release_date) ?? parseLegacyDate(plane?.release_date);
  return start && end ? { start, end } : null;
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

function suggestIterations(data: LegacyData, existing: Mapping['iterations'] | null): Mapping['iterations'] {
  const entries: IterationEntry[] = existing ? existing.iterations.map((e) => ({ ...e })) : [];
  const usedPlane = new Set(entries.flatMap((e) => e.planeIds));
  const usedPush = new Set(entries.flatMap((e) => e.pushIds));
  const fresh: IterationEntry[] = [];
  const groups = new Map<string, string[]>();
  for (const it of data.plane.iterations) {
    if (usedPlane.has(it.id)) continue;
    const sig = [it.kickoff_date, it.dev_start, it.dev_end, it.release_date].join('|');
    groups.set(sig, [...(groups.get(sig) ?? []), it.id]);
  }
  for (const ids of groups.values()) {
    const plane = data.plane.iterations.find((i) => i.id === ids[0])!;
    const release = parseLegacyDate(plane.release_date);
    const pushMatch = data.push.versions.find(
      (v) => !usedPush.has(v.id) && release && parseLegacyDate(v.release_date) && daysBetween(release, parseLegacyDate(v.release_date)!) <= 1,
    );
    if (pushMatch) usedPush.add(pushMatch.id);
    fresh.push({ key: `it_${legacyUuid('iteration', ids.join('|')).slice(0, 8)}`, name: pushMatch?.id ?? ids[0]!, type: 'regular', planeIds: ids, pushIds: pushMatch ? [pushMatch.id] : [] });
  }
  for (const v of data.push.versions) {
    if (usedPush.has(v.id)) continue;
    fresh.push({ key: `it_${legacyUuid('iteration', `push:${v.id}`).slice(0, 8)}`, name: v.name?.trim() || v.id, type: 'regular', planeIds: [], pushIds: [v.id] });
  }
  const windows = new Map(fresh.map((e) => [e.key, iterationWindow(e, data)]));
  for (const e of fresh.filter((x) => x.planeIds.length === 0)) {
    const w = windows.get(e.key);
    const overlaps = [...entries, ...fresh].some((o) => {
      if (o === e || o.type !== 'regular' || o.planeIds.length === 0) return false;
      const ow = windows.get(o.key) ?? iterationWindow(o, data);
      return !!w && !!ow && w.start < ow.end && ow.start < w.end;
    });
    if (overlaps) e.type = 'special';
  }
  return { iterations: [...entries, ...fresh] };
}

export function suggestMapping(data: LegacyData, existing: Mapping | null): Mapping {
  return {
    people: suggestPeople(data, existing?.people ?? null),
    platforms: suggestPlatforms(data, existing?.platforms ?? null),
    domains: suggestDomains(data, existing?.domains ?? null),
    iterations: suggestIterations(data, existing?.iterations ?? null),
  };
}
