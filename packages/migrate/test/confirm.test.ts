import { describe, expect, it, vi } from 'vitest';
import { resolveReplaceConfirmation } from '../src/confirm';

describe('resolveReplaceConfirmation', () => {
  it('replace=false 时直接通过，不询问', async () => {
    const ask = vi.fn();
    await expect(resolveReplaceConfirmation({ replace: false, orgSlug: 'pan123', isTTY: true, ask })).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('confirmFlag 与 slug 一致时通过', async () => {
    await expect(
      resolveReplaceConfirmation({ replace: true, orgSlug: 'pan123', confirmFlag: 'pan123', isTTY: false }),
    ).resolves.toBe('pan123');
  });

  it('confirmFlag 与 slug 不一致时抛错', async () => {
    await expect(resolveReplaceConfirmation({ replace: true, orgSlug: 'pan123', confirmFlag: 'Pan123', isTTY: false })).rejects.toThrow('slug');
    await expect(resolveReplaceConfirmation({ replace: true, orgSlug: 'pan123', confirmFlag: 'pan123 ', isTTY: false })).rejects.toThrow('slug');
  });

  it('非交互且没有 confirmFlag 时要求 --confirm-replace', async () => {
    await expect(resolveReplaceConfirmation({ replace: true, orgSlug: 'pan123', isTTY: false })).rejects.toThrow('--confirm-replace');
  });

  it('交互输入正确的 slug 时通过', async () => {
    const ask = vi.fn(async () => 'pan123');
    await expect(resolveReplaceConfirmation({ replace: true, orgSlug: 'pan123', isTTY: true, ask })).resolves.toBe('pan123');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('交互输入错误的 slug 时抛错', async () => {
    const ask = vi.fn(async () => 'other');
    await expect(resolveReplaceConfirmation({ replace: true, orgSlug: 'pan123', isTTY: true, ask })).rejects.toThrow('slug');
  });
});
