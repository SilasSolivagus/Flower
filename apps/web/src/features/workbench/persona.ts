/**
 * 工作台人格只影响呈现。解析顺序：
 * ① URL `?persona=`（预览，不写入偏好）
 * ② `accounts.preferences.workbenchPersona`
 * ③ 职能标签别名表（多标签取优先级更高者；同优先级视为并列，没有最近视角则中性）
 * ④ neutral（Phase 1 布局）
 *
 * 偏好若已设置，在第 ② 步返回，因此并列时的「最近视角」就是这份偏好。
 * 人格不读取 orgRole，也不授予权限。与 `AccountPreferences.workbenchPersona` 使用同一组短 id。
 */

export const WORKBENCH_PERSONAS = ['pm', 'dev', 'design', 'qa', 'boss', 'neutral'] as const;
export type WorkbenchPersona = (typeof WORKBENCH_PERSONAS)[number];

export type PersonaSource = 'url' | 'preference' | 'tag' | 'neutral';

/** 标签映射得到的人格。neutral 只来自未命中或显式偏好，不来自标签。 */
export type TaggedPersona = Exclude<WorkbenchPersona, 'neutral'>;

export type TagAlias = { persona: TaggedPersona; priority: number; names: readonly string[] };

export const SECTION_IDS = ['owned', 'following', 'tasks', 'signatures', 'confirmations', 'unread'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export type NowField = 'subtitle' | 'milestones' | 'overview' | 'attention' | 'blockers' | 'myTasks';

export type SectionLayout = {
  id: SectionId;
  emphasis: 'primary' | 'secondary';
  collapsedDefault: boolean;
};

export type PersonaLayout = {
  nowFields: Record<NowField, 'show' | 'collapse'>;
  /** Phase 3 外接槽。null 表示隐藏；有文案时只显示矮提示，不含链接。 */
  externalHint: string | null;
  sections: readonly SectionLayout[];
};

export const PERSONA_OPTIONS: ReadonlyArray<{ id: WorkbenchPersona; label: string }> = [
  { id: 'neutral', label: '中性' },
  { id: 'pm', label: '产品' },
  { id: 'dev', label: '研发' },
  { id: 'design', label: '设计' },
  { id: 'qa', label: '测试' },
  { id: 'boss', label: '管理者' },
];

/**
 * 数字大的优先。产品 50、研发 40、设计 30、测试 20、管理者 10。
 * 同优先级视为并列。别名按整名匹配，不把标签收成数据库枚举。
 */
export const FUNCTION_TAG_ALIASES: readonly TagAlias[] = [
  { persona: 'pm', priority: 50, names: ['产品', '产品经理', 'pm', 'product'] },
  { persona: 'dev', priority: 40, names: ['开发', '研发', '前端', '后端', '前端开发', '后端开发', '开发工程师', 'dev', '工程师', '客户端', '服务端'] },
  { persona: 'design', priority: 30, names: ['设计', '设计师', 'ui', 'ux', 'design'] },
  { persona: 'qa', priority: 20, names: ['测试', '测试工程师', 'qa', '质量'] },
  { persona: 'boss', priority: 10, names: ['管理者', '管理', '老板', 'boss'] },
];

const NEUTRAL_FIELDS: PersonaLayout['nowFields'] = {
  subtitle: 'show',
  milestones: 'show',
  overview: 'show',
  attention: 'show',
  blockers: 'show',
  myTasks: 'show',
};

function sections(spec: ReadonlyArray<readonly [SectionId, SectionLayout['emphasis'], boolean]>): SectionLayout[] {
  return spec.map(([id, emphasis, collapsedDefault]) => ({ id, emphasis, collapsedDefault }));
}

export const PERSONA_LAYOUTS: Record<WorkbenchPersona, PersonaLayout> = {
  neutral: {
    nowFields: NEUTRAL_FIELDS,
    externalHint: null,
    sections: sections([
      ['owned', 'secondary', false],
      ['following', 'secondary', false],
      ['tasks', 'secondary', false],
      ['signatures', 'secondary', false],
      ['confirmations', 'secondary', false],
      ['unread', 'secondary', false],
    ]),
  },
  pm: {
    nowFields: { ...NEUTRAL_FIELDS, myTasks: 'collapse' },
    externalHint: null,
    sections: sections([
      ['confirmations', 'primary', false],
      ['following', 'primary', false],
      ['owned', 'primary', false],
      ['signatures', 'secondary', false],
      ['unread', 'secondary', false],
      ['tasks', 'secondary', true],
    ]),
  },
  dev: {
    nowFields: { ...NEUTRAL_FIELDS, milestones: 'collapse' },
    externalHint: '仓库状态即将接入',
    sections: sections([
      ['tasks', 'primary', false],
      ['following', 'primary', false],
      ['owned', 'secondary', false],
      ['unread', 'secondary', false],
      ['signatures', 'secondary', true],
      ['confirmations', 'secondary', true],
    ]),
  },
  design: {
    nowFields: { ...NEUTRAL_FIELDS, overview: 'collapse', blockers: 'collapse', myTasks: 'collapse' },
    externalHint: '设计稿状态即将接入',
    sections: sections([
      ['owned', 'primary', false],
      ['following', 'primary', false],
      ['confirmations', 'secondary', false],
      ['unread', 'secondary', false],
      ['signatures', 'secondary', true],
      ['tasks', 'secondary', true],
    ]),
  },
  qa: {
    nowFields: { ...NEUTRAL_FIELDS, milestones: 'collapse', myTasks: 'collapse' },
    externalHint: '测试流水线即将接入',
    sections: sections([
      ['following', 'primary', false],
      ['signatures', 'primary', false],
      ['owned', 'secondary', false],
      ['confirmations', 'secondary', false],
      ['unread', 'secondary', false],
      ['tasks', 'secondary', true],
    ]),
  },
  boss: {
    nowFields: { ...NEUTRAL_FIELDS, myTasks: 'collapse' },
    externalHint: null,
    sections: sections([
      ['owned', 'primary', false],
      ['following', 'primary', false],
      ['confirmations', 'primary', false],
      ['signatures', 'secondary', false],
      ['unread', 'secondary', false],
      ['tasks', 'secondary', true],
    ]),
  },
};

export function layoutFor(persona: WorkbenchPersona): PersonaLayout {
  return PERSONA_LAYOUTS[persona];
}

export function parseWorkbenchPersona(value: string | null | undefined): WorkbenchPersona | null {
  if (!value) return null;
  return (WORKBENCH_PERSONAS as readonly string[]).includes(value) ? (value as WorkbenchPersona) : null;
}

export function normalizeTagName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 命中唯一最高优先级时返回该人格。并列且 tieBreak 落在并列集合里时用它打破；否则返回 null（调用方落中性）。 */
export function resolveTagPersona(tagNames: readonly string[], tieBreak: WorkbenchPersona | null, aliases: readonly TagAlias[] = FUNCTION_TAG_ALIASES): TaggedPersona | null {
  const index = new Map<string, { persona: TaggedPersona; priority: number }>();
  for (const alias of aliases) {
    for (const name of alias.names) {
      const key = normalizeTagName(name);
      const prev = index.get(key);
      if (!prev || alias.priority > prev.priority) index.set(key, { persona: alias.persona, priority: alias.priority });
    }
  }
  const best = new Map<TaggedPersona, number>();
  for (const raw of tagNames) {
    const hit = index.get(normalizeTagName(raw));
    if (!hit) continue;
    const prev = best.get(hit.persona);
    if (prev === undefined || hit.priority > prev) best.set(hit.persona, hit.priority);
  }
  if (best.size === 0) return null;
  let top = Number.NEGATIVE_INFINITY;
  for (const priority of best.values()) if (priority > top) top = priority;
  const tied = [...best.entries()].filter(([, priority]) => priority === top).map(([persona]) => persona);
  if (tied.length === 1) return tied[0] ?? null;
  if (tieBreak && tieBreak !== 'neutral' && tied.includes(tieBreak)) return tieBreak;
  return null;
}

export function resolvePersona(input: {
  urlPersona?: string | null;
  preference?: string | null;
  tagNames?: readonly string[];
  aliases?: readonly TagAlias[];
}): { persona: WorkbenchPersona; source: PersonaSource } {
  const aliases = input.aliases ?? FUNCTION_TAG_ALIASES;
  const url = parseWorkbenchPersona(input.urlPersona);
  if (url) return { persona: url, source: 'url' };
  const preference = parseWorkbenchPersona(input.preference);
  if (preference) return { persona: preference, source: 'preference' };
  const fromTags = resolveTagPersona(input.tagNames ?? [], null, aliases);
  if (fromTags) return { persona: fromTags, source: 'tag' };
  return { persona: 'neutral', source: 'neutral' };
}

export function tagNamesForMember(
  memberId: string | undefined,
  members: ReadonlyArray<{ id: string; functionTagIds: readonly string[] }> | undefined,
  tags: ReadonlyArray<{ id: string; name: string }> | undefined,
): string[] {
  if (!memberId || !members || !tags) return [];
  const member = members.find((item) => item.id === memberId);
  if (!member) return [];
  const names = new Map(tags.map((tag) => [tag.id, tag.name]));
  return member.functionTagIds.flatMap((id) => {
    const name = names.get(id);
    return name ? [name] : [];
  });
}

/** URL 已能决定人格时不必等标签。没有偏好时，要等组织角色和（非访客的）标签列表，避免先闪中性再跳人格。 */
export function personaInputsReady(input: {
  urlPersona: string | null;
  meLoaded: boolean;
  preference: string | null | undefined;
  orgLoaded: boolean;
  canReadTags: boolean;
  tagsLoaded: boolean;
}): boolean {
  if (parseWorkbenchPersona(input.urlPersona)) return true;
  if (!input.meLoaded) return false;
  if (parseWorkbenchPersona(input.preference)) return true;
  if (!input.orgLoaded) return false;
  if (!input.canReadTags) return true;
  return input.tagsLoaded;
}

export function nowFieldShown(layout: PersonaLayout, field: NowField, revealed: boolean): boolean {
  return revealed || layout.nowFields[field] === 'show';
}

export function nowLayoutHasFoldedFields(layout: PersonaLayout): boolean {
  return (Object.values(layout.nowFields) as Array<'show' | 'collapse'>).some((value) => value === 'collapse');
}
