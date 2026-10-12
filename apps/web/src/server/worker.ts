import { createDb, createNotificationWorker, defaultTransport, loadServerConfig } from '@flower/core';

const KEY = Symbol.for('flower.notificationWorker');
type Holder = Record<symbol, { stop: () => Promise<void> } | undefined>;

/**
 * 应用进程内的后台发送循环（instrumentation.ts 启动）。FLOWER_NOTIFY_WORKER=off 时不启动（测试与端到端改为调用 tick 接口）。
 * 用独立的小连接池；开发环境热重载时不重复启动；收到 SIGTERM / SIGINT 时停止取新任务。
 */
export function startNotificationWorker(env: Record<string, string | undefined> = process.env): boolean {
  if (env.FLOWER_NOTIFY_WORKER === 'off') return false;
  const holder = globalThis as unknown as Holder;
  if (holder[KEY]) return false;
  const config = loadServerConfig(env);
  const { db, close } = createDb(config.databaseUrl, { max: 2 });
  const worker = createNotificationWorker(db, { secretKey: config.secretKey, publicUrl: config.publicUrl, transport: defaultTransport });
  worker.start();
  const stop = async () => {
    await worker.stop();
    await close();
  };
  holder[KEY] = { stop };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void stop());
  return true;
}
