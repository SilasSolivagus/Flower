import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forkFieldForProduct, listFields } from '../src/definitions/fields';
import { createWorkflowTemplate } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement, setRequirementField } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('内置字段「类型」「工作类型」', () => {
  it('新组织预置两个字段与选项；「工作类型」作用于工作项', async () => {
    const fields = await listFields(t.db, owner);
    const type = fields.find((f) => f.key === 'type')!;
    const workType = fields.find((f) => f.key === 'work_type')!;
    expect(type).toMatchObject({ label: '类型', cardinality: 'single', builtin: true, appliesTo: 'requirement', productId: null });
    expect(type.options.map((o) => [o.key, o.label])).toEqual([
      ['feature', '新功能'],
      ['improvement', '体验优化'],
      ['incident', '线上问题'],
    ]);
    expect(workType).toMatchObject({ label: '工作类型', cardinality: 'single', builtin: true, appliesTo: 'work_item' });
    expect(workType.options.map((o) => [o.key, o.label])).toEqual([
      ['support', '技术支持'],
      ['coordination', '协调对接'],
    ]);
    expect(fields.find((f) => f.key === 'priority')!.appliesTo).toBe('requirement');
  });

  it('需求只用作用于需求的字段：可以设置「类型」，详情里没有「工作类型」，也不能给需求设置它', async () => {
    const type = (await listFields(t.db, owner)).find((f) => f.key === 'type')!;
    const r = await createRequirement(t.db, owner, pan, { title: '类型测试', fields: { type: [type.options[0]!.id] } });
    const d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.fields.find((f) => f.key === 'type')!.options.map((o) => o.label)).toEqual(['新功能']);
    expect(d.fields.map((f) => f.key)).not.toContain('work_type');
    await expect(setRequirementField(t.db, owner, r.id, 'work_type', [])).rejects.toMatchObject({ code: 'not_found' });
    expect((await listFields(t.db, owner, { productId: pan })).map((f) => f.key)).not.toContain('work_type');
  });

  it('工作项字段不能被产品覆盖，也不能作为流程条件', async () => {
    const workType = (await listFields(t.db, owner)).find((f) => f.key === 'work_type')!;
    await expect(forkFieldForProduct(t.db, owner, pan, workType.id)).rejects.toMatchObject({ code: 'invalid', message: '工作项字段只在组织级维护，不能被产品覆盖' });
    await expect(
      createWorkflowTemplate(t.db, owner, {
        name: '用工作类型做条件',
        body: {
          states: [
            { key: 'a', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
            { key: 'b', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
          ],
          initial: 'a',
          transitions: [{ from: '*', to: 'b', conditions: [{ type: 'field_set', field: 'work_type' }] }],
          checkItems: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: '流程定义有误' });
  });
});
