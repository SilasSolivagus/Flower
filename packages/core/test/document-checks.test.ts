import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/accounts';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { listDocumentReviewQueue, setDocumentCheckItemState, signDocumentCheckItem } from '../src/documents/checks';
import { createDocument, getDocumentByKey, transitionDocument } from '../src/documents/documents';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { getWorkbench } from '../src/workbench/workbench';
import { createTestDb } from './db';
import { asMember, prdWorkflow, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let outsider: Actor;
let req: RequirementListItem;
let docId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  const pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  await setMemberFunctionTags(t.db, owner, owner.memberId, [designTag]);
  const { version } = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  outsider = await asMember(t.db, owner, '没有设计标签的编辑');
  req = await createRequirement(t.db, owner, pan, { title: '分片上传' });
  docId = (await createDocument(t.db, owner, pan, { title: '上传 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/up', requirementIds: [req.id] })).id;
});
afterAll(() => t.cleanup());

describe('PRD 上的检查项', () => {
  it('PRD 详情列出作用于 PRD 的检查项；需求详情显示所挂 PRD、共享的检查项，「PRD」项标为不可手改', async () => {
    const d = await getDocumentByKey(t.db, owner, 'PAN-PRD-1');
    expect(d.checkItems).toMatchObject([{ key: 'prd_review', type: 'signoff', state: 'not_started', canSign: [0] }]);
    const r = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(r.changeDocument).toEqual({ id: docId, displayKey: 'PAN-PRD-1', title: '上传 PRD', status: 'draft', source: 'external' });
    expect(r.documentCheckItems.map((c) => c.key)).toEqual(['prd_review']);
    expect(r.checkItems.find((c) => c.key === 'prd')).toMatchObject({ state: 'in_progress', auto: true, locked: true });
    expect(r.checkItems.find((c) => c.key === 'feasibility')).toMatchObject({ auto: false, locked: false });
  });

  it('PRD 在评审中时进入「等我签字」与 PRD 评审表；签字结果挂在 PRD 上，覆盖的需求在流转条件中共享', async () => {
    expect((await getWorkbench(t.db, account.id)).signatures.items.filter((s) => s.documentId)).toEqual([]);
    await expect(transitionRequirement(t.db, owner, req.id, { to: 'doing' })).rejects.toMatchObject({
      code: 'invalid',
      details: { unmet: ['「PRD 评审」需为通过（当前：未开始）'] },
    });
    await transitionDocument(t.db, owner, docId, { to: 'review' });
    expect((await getWorkbench(t.db, account.id)).signatures.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ requirementId: null, documentId: docId, displayKey: 'PAN-PRD-1', itemLabel: 'PRD 评审', onBehalfOf: null })]),
    );
    const queue = await listDocumentReviewQueue(t.db, owner, req.productId);
    expect(queue.columns).toEqual([{ key: 'prd_review', label: 'PRD 评审', type: 'signoff' }]);
    expect(queue.rows).toMatchObject([{ displayKey: 'PAN-PRD-1', status: 'review', cells: { prd_review: { state: 'not_started', passed: 0, total: 1 } }, waiting: [{ itemKey: 'prd_review', ruleIndex: 0, onBehalf: false }] }]);

    await expect(signDocumentCheckItem(t.db, readOnlyToken(owner), docId, 'prd_review', { decision: 'passed' })).rejects.toMatchObject({ message: '只读 Token 不能签字' });
    await expect(signDocumentCheckItem(t.db, outsider, docId, 'prd_review', { decision: 'passed' })).rejects.toMatchObject({ message: '你不在该检查项的签字人中' });
    await expect(setDocumentCheckItemState(t.db, owner, docId, 'prd_review', { state: 'passed' })).rejects.toMatchObject({ message: '会签检查项的状态由签字结果决定' });
    expect(await signDocumentCheckItem(t.db, owner, docId, 'prd_review', { decision: 'passed' })).toEqual({ state: 'passed' });

    expect((await getRequirementByKey(t.db, owner, req.displayKey)).documentCheckItems[0]).toMatchObject({ state: 'passed', signoffs: [{ decision: 'passed' }] });
    expect(await transitionRequirement(t.db, owner, req.id, { to: 'doing' })).toEqual({ stateKey: 'doing' });
    expect((await getWorkbench(t.db, account.id)).signatures.items.filter((s) => s.documentId)).toEqual([]);
  });
});
