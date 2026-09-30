import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import type { Mapping, PersonEntry } from './mapping';
import { aliasKey, parsePersonName, splitNames } from './normalize';
import { BOSS_ROLE, parseProxySigner, SIGNOFF_ROLE_TAG } from './workflow-v1';

type Mention = { raw: string; email: string | null; role: 'owner' | 'developer' | 'requester' | 'signer' | 'other'; signoffRole?: string };

/** 工具或同步程序的名字：小写字母开头、用连字符连接的小写字母数字串（例：`data-sync`、`model-v4-flash`）。 */
export const AGENT_NAME = /^[a-z][a-z0-9.]*(?:-[a-z0-9.]+)+$/;
const HAN2 = /^\p{Script=Han}{2}$/u;
const HAN3 = /^\p{Script=Han}{3}$/u;
const LATIN_LOGIN = /^[a-z][a-z0-9._]*$/;

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
const emailUser = (email: string) => email.split('@')[0]!.toLowerCase();
const writtenForms = (p: PersonEntry) => [p.displayName, ...p.aliases, ...(p.email ? [p.email] : [])];

function addAliases(p: PersonEntry, aliases: string[]): void {
  for (const a of aliases) if (a.trim() && !p.aliases.some((x) => aliasKey(x) === aliasKey(a))) p.aliases.push(a);
}

/** 可以被删除或并入别人的条目：没有邮箱、没有标 keep、不是会签角色指向的人、不是 Agent。 */
function absorbable(p: PersonEntry, roleKeys: Set<string>): boolean {
  return !p.email && !p.keep && !roleKeys.has(p.key) && p.kind !== 'agent';
}

/**
 * 给一个可并入的条目找目标，按顺序：
 * 1. 某个写法是「头衔-姓名(昵称)」「姓名（昵称）」，按姓名找到别人（昵称一并作为别名）；
 * 2. 某个写法已经是别人的写法；
 * 3. 两个汉字的短名，与唯一一个三字姓名的后两字相同；
 * 4. 拉丁字母写法与唯一一个人的邮箱前缀相同。
 * 3、4 只在显示名仍是原始写法（没被用户改过）时使用。多个候选时优先有邮箱的、再按出现次数。
 */
function mergeTarget(e: PersonEntry, people: PersonEntry[]): { into: PersonEntry; extra: string[] } | null {
  const others = people.filter((p) => p !== e && p.kind !== 'agent');
  const holders = (s: string) => others.filter((p) => writtenForms(p).some((a) => aliasKey(a) === aliasKey(s)));
  const pick = (list: PersonEntry[]) => [...list].sort((a, b) => Number(!!b.email) - Number(!!a.email) || b.mentions - a.mentions)[0];
  for (const a of e.aliases) {
    const parsed = parsePersonName(a);
    if (parsed.name === a.trim()) continue;
    const into = pick(holders(parsed.name));
    if (into) return { into, extra: parsed.nickname ? [parsed.nickname] : [] };
  }
  for (const a of e.aliases) {
    const into = pick(holders(a));
    if (into) return { into, extra: [] };
  }
  if (!e.aliases.includes(e.displayName)) return null;
  if (HAN2.test(e.displayName)) {
    const hits = others.filter((p) => HAN3.test(p.displayName) && p.displayName.endsWith(e.displayName));
    if (hits.length === 1) return { into: hits[0]!, extra: [] };
  }
  if (LATIN_LOGIN.test(e.displayName)) {
    const hits = others.filter((p) => !!p.email && emailUser(p.email) === e.displayName);
    if (hits.length === 1) return { into: hits[0]!, extra: [] };
  }
  return null;
}

/**
 * 反复合并直到没有变化。并入本次新建的条目时合并职能标签与出现次数；并入用户已有的条目时只追加写法。
 * 没有目标、但写法带头衔或昵称且显示名仍是这个写法的，改用姓名作显示名。
 */
function mergeVariants(people: PersonEntry[], roleKeys: Set<string>, fresh: Set<PersonEntry>): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of people) {
      if (!absorbable(e, roleKeys)) continue;
      const target = mergeTarget(e, people);
      if (target) {
        addAliases(target.into, [e.displayName, ...e.aliases, ...target.extra]);
        if (fresh.has(target.into)) {
          target.into.mentions += e.mentions;
          for (const t of e.functionTags) if (!target.into.functionTags.includes(t)) target.into.functionTags.push(t);
        }
        people.splice(people.indexOf(e), 1);
        changed = true;
        break;
      }
      const titled = e.aliases.map(parsePersonName).find((p, i) => p.name !== e.aliases[i]!.trim() && e.displayName === e.aliases[i]);
      if (titled) {
        e.displayName = titled.name;
        addAliases(e, [titled.name, ...(titled.nickname ? [titled.nickname] : [])]);
        changed = true;
      }
    }
  }
}

export function suggestPeople(data: LegacyData, existing: Mapping['people'] | null): Mapping['people'] {
  const people: PersonEntry[] = existing ? existing.people.map((p) => ({ ...p, aliases: [...p.aliases], functionTags: [...p.functionTags] })) : [];
  const signoffRoles: Record<string, string> = { ...(existing?.signoffRoles ?? {}) };
  const roleKeys = () => new Set(Object.values(signoffRoles));
  for (const p of people) p.kind ??= !p.email && AGENT_NAME.test(p.displayName) ? 'agent' : 'human';
  // 旧版对照表把「甲、乙」这类多人写法或「代X by Y」代签写法整体建成了一个人：删掉这种条目，导入时由 Resolver 逐个解析
  const composite = (a: string) => splitNames(a).length > 1 || parseProxySigner(a) !== null;
  for (const p of people.filter((x) => absorbable(x, roleKeys()) && x.aliases.length > 0 && x.aliases.every(composite))) {
    people.splice(people.indexOf(p), 1);
  }

  const byAlias = new Map<string, PersonEntry>();
  const index = (p: PersonEntry) => {
    for (const a of writtenForms(p)) byAlias.set(aliasKey(a), p);
  };
  people.forEach(index);
  const nameToEmail = new Map<string, string>();
  for (const u of [...data.plane.users, ...data.prd.users]) if (u.name) nameToEmail.set(aliasKey(u.name), u.email.trim().toLowerCase());
  const planeUser = new Map(data.plane.users.map((u) => [u.email.trim().toLowerCase(), u]));
  const usedKeys = new Set(people.map((p) => p.key));
  const uniqueKey = (base: string) => {
    let k = base;
    for (let i = 2; usedKeys.has(k); i++) k = `${base}_${i}`;
    usedKeys.add(k);
    return k;
  };
  const fresh = new Set<PersonEntry>();

  function addPerson(name: string, email: string | null): PersonEntry {
    const user = email ? planeUser.get(email) : undefined;
    const p: PersonEntry = {
      key: uniqueKey(email ? `p_${localPart(email)}` : `p_${legacyUuid('person', name).slice(0, 8)}`),
      displayName: user?.name ?? name,
      email,
      kind: !email && AGENT_NAME.test(name) ? 'agent' : 'human',
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

  for (const m of collectPersonMentions(data)) {
    if (m.signoffRole === BOSS_ROLE && m.raw === BOSS_ROLE) {
      if (!signoffRoles[BOSS_ROLE]) {
        const p = byAlias.get(aliasKey(BOSS_ROLE)) ?? addPerson(BOSS_ROLE, null);
        signoffRoles[BOSS_ROLE] = p.key;
      }
      continue;
    }
    // 「代X by Y」出现在会签以外的字段（例如变更记录）时，只是 Y 的一次操作
    const raw = parseProxySigner(m.raw)?.actor ?? m.raw;
    const parts = byAlias.has(aliasKey(raw)) ? [raw] : splitNames(raw);
    for (const part of parts) {
      const email = (parts.length === 1 ? m.email : null) ?? nameToEmail.get(aliasKey(part)) ?? null;
      let p = byAlias.get(aliasKey(part)) ?? (email ? byAlias.get(aliasKey(email)) : undefined);
      if (!p) p = addPerson(part.includes('@') ? part.split('@')[0]! : part, email);
      if (!p.aliases.some((a) => aliasKey(a) === aliasKey(part))) {
        p.aliases.push(part);
        index(p);
      }
      if (fresh.has(p)) {
        p.mentions += 1;
        const tag =
          p.kind === 'agent'
            ? undefined
            : m.role === 'owner'
              ? '产品经理'
              : m.role === 'developer'
                ? '开发'
                : m.role === 'signer' && m.signoffRole
                  ? SIGNOFF_ROLE_TAG[m.signoffRole]
                  : undefined;
        if (tag && !p.functionTags.includes(tag)) p.functionTags.push(tag);
      }
    }
  }

  mergeVariants(people, roleKeys(), fresh);
  for (const p of fresh) p.functionTags.sort();
  return { people, signoffRoles };
}
