import { createDb, createLocalStorage, loadServerConfig } from '@flower/core';
import { type App, createApi } from './api';

let api: App | undefined;

export function getApi(): App {
  if (!api) {
    const config = loadServerConfig();
    const { db } = createDb(config.databaseUrl);
    api = createApi({ db, secureCookies: config.publicUrl.startsWith('https://'), publicUrl: config.publicUrl, storage: createLocalStorage(config.storageDir) });
  }
  return api;
}
