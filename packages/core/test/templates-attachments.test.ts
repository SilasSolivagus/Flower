import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents, domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { readAttachment, sniffImage, uploadDocumentImage } from '../src/documents/attachments';
import { createPresetTemplate, createTemplate, listTemplates, PRESET_TEMPLATE, updateTemplate } from '../src/documents/templates';
import { createLocalStorage } from '../src/storage';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

const eventsOf = (subjectId: string, type: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type))));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let productAdmin: Actor;
let pan: string;
let docId: string;
let dir: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  productAdmin = await asMember(t.db, owner, '产品管理员丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  await setProductRole(t.db, owner, pan, productAdmin.memberId, 'admin');
  const [doc] = await t.adminDb
    .insert(documents)
    .values({ orgId: owner.orgId, productId: pan, number: 1, source: 'external', title: '外部 PRD', externalUrl: 'https://example.com/a', externalUrlKey: 'https://example.com/a', externalProvider: 'other' })
    .returning();
  docId = doc!.id;
  dir = mkdtempSync(path.join(os.tmpdir(), 'flower-storage-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await t.cleanup();
});

describe('文档模板', () => {
  it('新组织自带预置模板；预置模板不能重复添加', async () => {
    const list = await listTemplates(t.db, owner, {});
    expect(list).toMatchObject([{ name: PRESET_TEMPLATE.name, productId: null, active: true }]);
    expect(list[0]!.sections.filter((s) => s.required).map((s) => s.heading)).toEqual(['1. 背景介绍', '3. 需求说明']);
    await expect(createPresetTemplate(t.db, owner)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('组织模板只有组织管理员能建；产品模板由产品管理员建，并按名称覆盖组织模板', async () => {
    const input = { name: '轻量 PRD', body: '## 背景\n', sections: [{ heading: '背景', required: true }] };
    await expect(createTemplate(t.db, editor, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createTemplate(t.db, readOnlyToken(owner), input)).rejects.toMatchObject({ code: 'forbidden' });
    const orgTpl = await createTemplate(t.db, owner, input);
    await expect(createTemplate(t.db, owner, input)).rejects.toMatchObject({ code: 'conflict', message: '已有同名模板' });
    await expect(createTemplate(t.db, editor, { ...input, productId: pan })).rejects.toMatchObject({ code: 'forbidden' });
    const productTpl = await createTemplate(t.db, productAdmin, { ...input, productId: pan, body: '## 背景\n\n产品版\n' });
    const usable = await listTemplates(t.db, viewer, { productId: pan, usable: true });
    expect(usable.map((x) => x.id)).toEqual([expect.any(String), productTpl.id]);
    expect(usable.find((x) => x.id === orgTpl.id)).toBeUndefined();
    expect(await listTemplates(t.db, viewer, { productId: pan })).toEqual([productTpl]);
    await updateTemplate(t.db, productAdmin, productTpl.id, { active: false });
    expect((await listTemplates(t.db, viewer, { productId: pan, usable: true })).map((x) => x.id)).toContain(orgTpl.id);
    await expect(updateTemplate(t.db, productAdmin, orgTpl.id, { active: false })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('小节标题不能为空或重复', async () => {
    await expect(createTemplate(t.db, owner, { name: '坏模板', body: '', sections: [{ heading: ' ', required: true }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      createTemplate(t.db, owner, { name: '坏模板', body: '', sections: [{ heading: '背景', required: true }, { heading: '背景', required: false }] }),
    ).rejects.toMatchObject({ code: 'invalid', message: '小节标题不能重复' });
  });
});

describe('图片附件', () => {
  it('按文件头判断类型', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(SVG)).toBeNull();
  });

  it('编辑可以上传，只读成员可以读取；只读成员、只读 Token 不能上传；SVG 与超限文件被拒绝', async () => {
    const storage = createLocalStorage(dir);
    const att = await uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'shot.png', bytes: PNG, storage });
    expect(att).toMatchObject({ filename: 'shot.png', mime: 'image/png', sizeBytes: PNG.byteLength });
    const events = await eventsOf(docId, 'attachment.uploaded');
    expect(events[0]!.payload).toMatchObject({ changes: [{ field: 'attachment', old: null, new: 'shot.png' }] });
    const read = await readAttachment(t.db, viewer, { attachmentId: att.id, storage });
    expect(read.mime).toBe('image/png');
    expect([...read.bytes]).toEqual([...PNG]);
    await expect(uploadDocumentImage(t.db, viewer, { documentId: docId, filename: 'a.png', bytes: PNG, storage })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(uploadDocumentImage(t.db, readOnlyToken(owner), { documentId: docId, filename: 'a.png', bytes: PNG, storage })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'x.svg', bytes: SVG, storage })).rejects.toMatchObject({
      code: 'invalid',
      message: '只支持 PNG、JPEG、GIF、WebP 图片',
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    await expect(uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'big.png', bytes: big, storage })).rejects.toMatchObject({ message: '图片不能超过 10 MB' });
  });

  it('文件丢失时读取报「附件文件不存在」', async () => {
    const storage = createLocalStorage(dir);
    const att = await uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'gone.png', bytes: PNG, storage });
    await expect(readAttachment(t.db, owner, { attachmentId: att.id, storage: createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-empty-'))) })).rejects.toMatchObject({
      code: 'not_found',
      message: '附件文件不存在',
    });
  });

  it('本地存储：合法键可以写入读出；非法键（路径穿越、绝对路径、空字符串）一律拒绝', async () => {
    const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-storage-key-')));
    const key = '0196b2b4-0000-7000-8000-000000000001/0196b2b4-0000-7000-8000-000000000002.png';
    await storage.put(key, PNG);
    expect([...(await storage.get(key))!]).toEqual([...PNG]);
    const bad = ['../x', 'a/../../etc/passwd', '/etc/passwd', ''];
    for (const k of bad) {
      await expect(storage.put(k, PNG)).rejects.toThrow('非法的存储键');
      await expect(storage.get(k)).rejects.toThrow('非法的存储键');
    }
  });
});
