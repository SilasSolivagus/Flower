import { describe, expect, it } from 'vitest';
import { startNotificationWorker } from '@/server/worker';

describe('后台发送循环的开关', () => {
  it('FLOWER_NOTIFY_WORKER=off 时不启动，也不需要数据库配置', () => {
    expect(startNotificationWorker({ FLOWER_NOTIFY_WORKER: 'off' })).toBe(false);
  });
});
