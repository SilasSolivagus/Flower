import { createDb, createLocalStorage, defaultTransport, loadServerConfig, WECOM_API_BASE } from '@flower/core';
import { type App, createApi } from './api';

let api: App | undefined;

export function getApi(): App {
  if (!api) {
    const config = loadServerConfig();
    const { db } = createDb(config.databaseUrl);
    api = createApi({
      db,
      secureCookies: config.publicUrl.startsWith('https://'),
      publicUrl: config.publicUrl,
      storage: createLocalStorage(config.storageDir),
      notify: { secretKey: config.secretKey, publicUrl: config.publicUrl, transport: defaultTransport },
      tickApi: process.env.FLOWER_NOTIFY_TICK_API === '1',
      wecomApiBase: WECOM_API_BASE,
    });
  }
  return api;
}
