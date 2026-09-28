import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_WORKFLOW_BODY } from '../src/definitions/defaults';
import {
  createWorkflowTemplate,
  forkWorkflowForProduct,
  getProductWorkflow,
  getWorkflowDefinition,
  listWorkflowTemplates,
  publishWorkflowVersion,
  setProductWorkflowVersion,
} from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { AppError } from '../src/errors';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

const withReview = {
  ...DEFAULT_WORKFLOW_BODY,
  checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
  transitions: [
    { from: 'backlog', to: 'todo', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] },
    { from: '*', to: 'canceled', conditions: [] },
  ],
};

describe('流程定义', () => {
  it('组织有一份默认模板，产品默认使用它', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    expect(templates.map((x) => x.name)).toEqual(['默认流程']);
    const pw = await getProductWorkflow(t.db, owner, productId);
    expect(pw.definition.id).toBe(templates[0]!.id);
    expect(pw.version.body.initial).toBe('backlog');
  });

  it('创建模板并发布新版本，旧版本保持不变', async () => {
    const { definition, version } = await createWorkflowTemplate(t.db, owner, { name: '网盘流程', body: DEFAULT_WORKFLOW_BODY });
    expect(version.version).toBe(1);
    const v2 = await publishWorkflowVersion(t.db, owner, definition.id, { body: withReview, note: '加可行性评估' });
    expect(v2.version).toBe(2);
    const { definition: d, versions } = await getWorkflowDefinition(t.db, owner, definition.id);
    expect(d.currentVersion).toBe(2);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]!.body.checkItems).toEqual([]);
  });

  it('非法定义返回 invalid 与问题清单', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    const err = await publishWorkflowVersion(t.db, owner, templates[0]!.id, {
      body: { ...DEFAULT_WORKFLOW_BODY, initial: 'ghost' },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('invalid');
    expect(err.details).toEqual([{ path: 'initial', message: '初始状态「ghost」不存在' }]);
  });

  it('条件可以引用组织字段', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    const v = await publishWorkflowVersion(t.db, owner, templates[0]!.id, {
      body: {
        ...DEFAULT_WORKFLOW_BODY,
        transitions: [{ from: 'backlog', to: 'todo', conditions: [{ type: 'field_set', field: 'priority' }] }],
      },
    });
    expect(v.version).toBe(2);
  });

  it('产品从模板复制一份覆盖，并切换到覆盖版本', async () => {
    const templates = await listWorkflowTemplates(t.db, owner);
    const { definition, version } = await forkWorkflowForProduct(t.db, owner, productId, {
      fromVersionId: templates[0]!.currentVersionId!,
    });
    expect(definition.productId).toBe(productId);
    expect(definition.forkedFromVersionId).toBe(templates[0]!.currentVersionId);
    expect((await getProductWorkflow(t.db, owner, productId)).version.id).toBe(version.id);
    expect((await listWorkflowTemplates(t.db, owner)).some((d) => d.id === definition.id)).toBe(false);
  });

  it('产品只能切换到模板版本或自己的覆盖版本', async () => {
    const other = await createProduct(t.db, owner, { name: '会员', key: 'VIP' });
    const otherFork = await forkWorkflowForProduct(t.db, owner, other.id, {
      fromVersionId: (await listWorkflowTemplates(t.db, owner))[0]!.currentVersionId!,
    });
    await expect(setProductWorkflowVersion(t.db, owner, productId, otherFork.version.id)).rejects.toMatchObject({ code: 'invalid' });
    const tpl = (await listWorkflowTemplates(t.db, owner))[0]!;
    await setProductWorkflowVersion(t.db, owner, productId, tpl.currentVersionId!);
    expect((await getProductWorkflow(t.db, owner, productId)).version.id).toBe(tpl.currentVersionId);
  });

  it('普通成员不能管理模板', async () => {
    await expect(createWorkflowTemplate(t.db, { ...owner, orgRole: 'member' }, { name: 'x', body: DEFAULT_WORKFLOW_BODY })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('产品不能复制其他产品的流程覆盖', async () => {
    const other = await createProduct(t.db, owner, { name: '文档', key: 'DOC' });
    const otherFork = await forkWorkflowForProduct(t.db, owner, other.id, {
      fromVersionId: (await listWorkflowTemplates(t.db, owner))[0]!.currentVersionId!,
    });
    await expect(forkWorkflowForProduct(t.db, owner, productId, { fromVersionId: otherFork.version.id })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('复制流程后产生 product.workflow_changed 事件', async () => {
    const other = await createProduct(t.db, owner, { name: '任务', key: 'TODO' });
    const { version } = await forkWorkflowForProduct(t.db, owner, other.id, {
      fromVersionId: (await listWorkflowTemplates(t.db, owner))[0]!.currentVersionId!,
    });
    const events = await withOrg(t.db, owner.orgId, async (tx) => {
      return tx
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.type, 'product.workflow_changed'));
    });
    const forkEvent = events.find((e) => {
      const changes = (e.payload as { changes: Array<{ field: string; old: unknown; new: unknown }> }).changes;
      return e.subjectId === other.id && changes[0]?.new === version.id;
    });
    expect(forkEvent).toBeDefined();
    const changes = (forkEvent?.payload as { changes: Array<{ field: string; old: unknown; new: unknown }> }).changes;
    expect(changes[0]?.field).toBe('workflowVersionId');
    expect(changes[0]?.new).toBe(version.id);
  });
});
