import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { BRIEF_TEMPLATE } from '../src/documents/brief-template';
import { createPresetTemplate, createTemplate, effectiveTemplates, listTemplates, PRESET_TEMPLATE, updateTemplate } from '../src/documents/templates';
import type { Actor } from '../src/domain-types';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productAdmin: Actor;
let editor: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  productAdmin = await asMember(t.db, owner, '产品管理员丙');
  await setProductRole(t.db, owner, pan, productAdmin.memberId, 'admin');
  editor = await asMember(t.db, owner, '编辑丁');
});
afterAll(() => t.cleanup());

describe('模板按类型', () => {
  it('新组织同时有预置 PRD 模板与预置简报模板；按类型分开列出，原有调用只看到 PRD 模板', async () => {
    expect((await listTemplates(t.db, owner, {})).map((x) => [x.kind, x.name])).toEqual([['change', PRESET_TEMPLATE.name]]);
    const briefs = await listTemplates(t.db, owner, { kind: 'brief' });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ kind: 'brief', productId: null, name: BRIEF_TEMPLATE.name, body: BRIEF_TEMPLATE.body, guidance: BRIEF_TEMPLATE.guidance, active: true });
    expect(briefs[0]!.sections).toEqual(BRIEF_TEMPLATE.sections);
    expect((await listTemplates(t.db, owner, { productId: pan, usable: true, kind: 'brief' })).map((x) => x.name)).toEqual([BRIEF_TEMPLATE.name]);
    expect((await listTemplates(t.db, owner, { productId: pan, usable: true })).map((x) => x.name)).toEqual([PRESET_TEMPLATE.name]);
  });

  it('产品管理员用同名模板覆盖组织简报模板；PRD 模板不受影响；编辑不能新建模板；PRD 与简报模板可以同名', async () => {
    await createTemplate(t.db, productAdmin, {
      productId: pan,
      kind: 'brief',
      name: BRIEF_TEMPLATE.name,
      body: '## 1. 问题与目标\n\n产品版\n',
      sections: [{ heading: '1. 问题与目标', required: true }],
      guidance: '本产品的写法',
    });
    const usable = await withOrg(t.db, owner.orgId, (tx) => effectiveTemplates(tx, pan, 'brief'));
    expect(usable.map((x) => [x.productId, x.guidance])).toEqual([[pan, '本产品的写法']]);
    expect((await withOrg(t.db, owner.orgId, (tx) => effectiveTemplates(tx, pan))).map((x) => x.name)).toEqual([PRESET_TEMPLATE.name]);
    await expect(createTemplate(t.db, editor, { productId: pan, kind: 'brief', name: '编辑的模板', body: '', sections: [] })).rejects.toMatchObject({ code: 'forbidden' });
    const same = await createTemplate(t.db, owner, { kind: 'change', name: BRIEF_TEMPLATE.name, body: '', sections: [] });
    expect(same.kind).toBe('change');
  });

  it('模板说明不超过 2000 字；修改记入 template.updated 的 changes', async () => {
    const [b] = await listTemplates(t.db, owner, { kind: 'brief' });
    await expect(updateTemplate(t.db, owner, b!.id, { guidance: 'x'.repeat(2001) })).rejects.toThrow('模板说明不超过 2000 个字符');
    expect((await updateTemplate(t.db, owner, b!.id, { guidance: '先写结论' })).guidance).toBe('先写结论');
    const [ev] = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'template.updated'), eq(domainEvents.subjectId, b!.id)));
    expect(ev!.payload.changes).toEqual([{ field: 'guidance', old: BRIEF_TEMPLATE.guidance, new: '先写结论' }]);
  });

  it('预置简报模板已存在时不能重复添加', async () => {
    await expect(createPresetTemplate(t.db, owner, 'brief')).rejects.toMatchObject({ code: 'conflict', message: '预置模板已存在' });
  });
});
