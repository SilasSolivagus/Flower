import { describe, expect, it } from 'vitest';
import {
  FUNCTION_TAG_ALIASES,
  layoutFor,
  nowFieldShown,
  nowLayoutHasFoldedFields,
  PERSONA_LAYOUTS,
  personaInputsReady,
  type PersonaLayout,
  resolvePersona,
  resolveTagPersona,
  SECTION_IDS,
  type TagAlias,
  tagNamesForMember,
  WORKBENCH_PERSONAS,
} from './persona';

const TIE: readonly TagAlias[] = [
  { persona: 'design', priority: 10, names: ['设计'] },
  { persona: 'qa', priority: 10, names: ['测试'] },
];

function signature(layout: PersonaLayout): string {
  return JSON.stringify({
    sections: layout.sections.map((section) => [section.id, section.emphasis, section.collapsedDefault]),
    now: layout.nowFields,
    hint: layout.externalHint,
  });
}

describe('职能标签到人格', () => {
  it('默认职能标签名映射到对应人格，未知标签落中性', () => {
    expect(resolvePersona({ tagNames: ['产品经理'] })).toEqual({ persona: 'pm', source: 'tag' });
    expect(resolvePersona({ tagNames: ['开发'] })).toEqual({ persona: 'dev', source: 'tag' });
    expect(resolvePersona({ tagNames: ['设计'] })).toEqual({ persona: 'design', source: 'tag' });
    expect(resolvePersona({ tagNames: ['测试'] })).toEqual({ persona: 'qa', source: 'tag' });
    expect(resolvePersona({ tagNames: ['老板'] })).toEqual({ persona: 'boss', source: 'tag' });
    expect(resolvePersona({ tagNames: ['QA'] })).toEqual({ persona: 'qa', source: 'tag' });
    expect(resolvePersona({ tagNames: [' 前端 '] })).toEqual({ persona: 'dev', source: 'tag' });
    expect(resolvePersona({ tagNames: ['不存在的标签'] })).toEqual({ persona: 'neutral', source: 'neutral' });
    expect(resolvePersona({ tagNames: [] })).toEqual({ persona: 'neutral', source: 'neutral' });
  });

  it('多标签取表优先级更高的人格', () => {
    expect(resolvePersona({ tagNames: ['开发', '产品经理'] })).toEqual({ persona: 'pm', source: 'tag' });
    expect(resolvePersona({ tagNames: ['测试', '开发'] })).toEqual({ persona: 'dev', source: 'tag' });
    expect(resolvePersona({ tagNames: ['老板', '设计'] })).toEqual({ persona: 'design', source: 'tag' });
  });

  it('同优先级且没有最近视角时落中性；最近视角能打破并列', () => {
    expect(resolveTagPersona(['设计', '测试'], null, TIE)).toBeNull();
    expect(resolveTagPersona(['设计', '测试'], 'qa', TIE)).toBe('qa');
    expect(resolveTagPersona(['设计', '测试'], 'boss', TIE)).toBeNull();
    expect(resolveTagPersona(['设计', '测试'], 'neutral', TIE)).toBeNull();
    expect(resolvePersona({ tagNames: ['设计', '测试'], aliases: TIE })).toEqual({ persona: 'neutral', source: 'neutral' });
    expect(resolvePersona({ tagNames: ['设计', '测试'], preference: 'qa', aliases: TIE })).toEqual({ persona: 'qa', source: 'preference' });
    expect(resolvePersona({ tagNames: ['设计', '测试'], preference: 'boss', aliases: TIE })).toEqual({ persona: 'boss', source: 'preference' });
  });

  it('URL 只预览，优先于偏好和标签；非法 query 忽略', () => {
    expect(resolvePersona({ urlPersona: 'boss', preference: 'pm', tagNames: ['产品经理'] })).toEqual({ persona: 'boss', source: 'url' });
    expect(resolvePersona({ urlPersona: 'neutral', tagNames: ['产品经理'] })).toEqual({ persona: 'neutral', source: 'url' });
    expect(resolvePersona({ urlPersona: 'persona.pm', tagNames: ['开发'] })).toEqual({ persona: 'dev', source: 'tag' });
    expect(resolvePersona({ urlPersona: 'owner', preference: 'qa' })).toEqual({ persona: 'qa', source: 'preference' });
    expect(resolvePersona({ preference: null, tagNames: ['产品经理'] })).toEqual({ persona: 'pm', source: 'tag' });
  });

  it('已保存的中性视角压过职能标签', () => {
    expect(resolvePersona({ preference: 'neutral', tagNames: ['产品经理'] })).toEqual({ persona: 'neutral', source: 'preference' });
  });

  it('解析结果只有人格和来源，boss 不带权限字段', () => {
    expect(Object.keys(resolvePersona({ urlPersona: 'boss' })).sort()).toEqual(['persona', 'source']);
    expect(FUNCTION_TAG_ALIASES.some((alias) => alias.persona === 'boss')).toBe(true);
  });

  it('按成员的职能标签 id 取出名称', () => {
    expect(
      tagNamesForMember('m1', [{ id: 'm1', functionTagIds: ['t2', 'missing'] }], [
        { id: 't1', name: '开发' },
        { id: 't2', name: '产品经理' },
      ]),
    ).toEqual(['产品经理']);
    expect(tagNamesForMember(undefined, [], [])).toEqual([]);
  });

  it('没有偏好时要等标签，URL 或已有偏好可以先定', () => {
    expect(personaInputsReady({ urlPersona: 'pm', meLoaded: false, preference: null, orgLoaded: false, canReadTags: false, tagsLoaded: false })).toBe(true);
    expect(personaInputsReady({ urlPersona: null, meLoaded: true, preference: 'dev', orgLoaded: false, canReadTags: true, tagsLoaded: false })).toBe(true);
    expect(personaInputsReady({ urlPersona: null, meLoaded: true, preference: null, orgLoaded: false, canReadTags: false, tagsLoaded: false })).toBe(false);
    expect(personaInputsReady({ urlPersona: null, meLoaded: true, preference: null, orgLoaded: true, canReadTags: false, tagsLoaded: false })).toBe(true);
    expect(personaInputsReady({ urlPersona: null, meLoaded: true, preference: null, orgLoaded: true, canReadTags: true, tagsLoaded: false })).toBe(false);
    expect(personaInputsReady({ urlPersona: 'nope', meLoaded: true, preference: null, orgLoaded: true, canReadTags: true, tagsLoaded: true })).toBe(true);
  });
});

describe('布局表', () => {
  it('五个人格和中性都有条目，六块齐全且不重复', () => {
    expect(Object.keys(PERSONA_LAYOUTS).sort()).toEqual([...WORKBENCH_PERSONAS].sort());
    for (const persona of WORKBENCH_PERSONAS) {
      const layout = layoutFor(persona);
      expect(layout.sections.map((section) => section.id).sort()).toEqual([...SECTION_IDS].sort());
      expect(new Set(layout.sections.map((section) => section.id)).size).toBe(SECTION_IDS.length);
    }
  });

  it('中性布局等于 Phase 1：原顺序、不强调、不折叠、无外接提示', () => {
    const neutral = layoutFor('neutral');
    expect(neutral.sections.map((section) => section.id)).toEqual([...SECTION_IDS]);
    expect(neutral.sections.every((section) => section.emphasis === 'secondary' && section.collapsedDefault === false)).toBe(true);
    expect(Object.values(neutral.nowFields).every((value) => value === 'show')).toBe(true);
    expect(neutral.externalHint).toBeNull();
    expect(nowLayoutHasFoldedFields(neutral)).toBe(false);
    expect(nowFieldShown(neutral, 'myTasks', false)).toBe(true);
  });

  it('至少三种布局可区分，外接槽只有矮提示', () => {
    const unique = new Set(WORKBENCH_PERSONAS.map((persona) => signature(layoutFor(persona))));
    expect(unique.size).toBeGreaterThanOrEqual(4);
    expect(signature(layoutFor('pm'))).not.toBe(signature(layoutFor('neutral')));
    expect(signature(layoutFor('dev'))).not.toBe(signature(layoutFor('pm')));
    expect(signature(layoutFor('design'))).not.toBe(signature(layoutFor('dev')));
    expect(layoutFor('pm').nowFields.myTasks).toBe('collapse');
    expect(layoutFor('dev').nowFields.myTasks).toBe('show');
    expect(layoutFor('pm').sections[0]?.id).toBe('confirmations');
    expect(layoutFor('dev').sections[0]?.id).toBe('tasks');
    expect(layoutFor('boss').sections[0]?.id).toBe('owned');
    for (const persona of ['design', 'dev', 'qa'] as const) {
      const hint = layoutFor(persona).externalHint;
      expect(hint).toContain('即将接入');
      expect(hint).not.toMatch(/https?:|figma\.com|github\.com/i);
    }
    expect(layoutFor('pm').externalHint).toBeNull();
    expect(layoutFor('boss').externalHint).toBeNull();
    const folded = layoutFor('pm');
    expect(nowFieldShown(folded, 'myTasks', false)).toBe(false);
    expect(nowFieldShown(folded, 'myTasks', true)).toBe(true);
  });
});
