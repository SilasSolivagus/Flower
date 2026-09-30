import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import type { IterationEntry, Mapping } from './mapping';
import { aliasKey, parseJsonArray, parseLegacyDate, splitPlatforms } from './normalize';
import { suggestPeople } from './people';
import { DEFAULT_PLATFORM_OPTIONS, KNOWN_PLATFORM_ALIASES } from './workflow-v1';

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
  return { iterations: [...entries, ...fresh], ...(existing?.ignore ? { ignore: existing.ignore } : {}) };
}

export function suggestMapping(data: LegacyData, existing: Mapping | null): Mapping {
  return {
    people: suggestPeople(data, existing?.people ?? null),
    platforms: suggestPlatforms(data, existing?.platforms ?? null),
    domains: suggestDomains(data, existing?.domains ?? null),
    iterations: suggestIterations(data, existing?.iterations ?? null),
  };
}
