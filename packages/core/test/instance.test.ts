import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from '../src/auth/sessions';
import { getInstanceStatus, initializeInstance, signUp, updateInstanceSettings } from '../src/setup/instance';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

const input = {
  admin: { email: 'owner@example.com', name: 'Owner', password: 'password123' },
  org: { name: '123云盘', slug: 'pan' },
};

describe('实例初始化', () => {
  it('初始化前状态为未初始化、默认邀请制', async () => {
    expect(await getInstanceStatus(t.db)).toEqual({ initialized: false, allowSignup: false, allowOrgCreation: false });
  });

  it('初始化创建实例管理员与第一个组织', async () => {
    const r = await initializeInstance(t.db, input);
    expect(r.account.isInstanceAdmin).toBe(true);
    expect(r.org.slug).toBe('pan');
    expect((await getInstanceStatus(t.db)).initialized).toBe(true);
  });

  it('不能重复初始化', async () => {
    await expect(
      initializeInstance(t.db, { ...input, admin: { ...input.admin, email: 'x@example.com' }, org: { name: 'X', slug: 'x' } }),
    ).rejects.toMatchObject({ code: 'already_initialized' });
  });

  it('默认不开放注册', async () => {
    await expect(signUp(t.db, { email: 'new@example.com', name: 'New', password: 'password123' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('实例管理员开放注册后可以注册；只有实例管理员能修改实例设置', async () => {
    const { account: ownerView } = await login(t.db, { email: 'owner@example.com', password: 'password123' });
    const status = await updateInstanceSettings(t.db, ownerView, { allowSignup: true });
    expect(status.allowSignup).toBe(true);
    const created = await signUp(t.db, { email: 'new@example.com', name: 'New', password: 'password123' });
    expect(created.isInstanceAdmin).toBe(false);
    await expect(updateInstanceSettings(t.db, created, { allowOrgCreation: true })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
