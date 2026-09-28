import { createDb, loadConfig } from '@flower/core';
import { type App, createApi } from './api';

let api: App | undefined;

export function getApi(): App {
  if (!api) {
    const config = loadConfig();
    const { db } = createDb(config.databaseUrl);
    api = createApi({ db, secureCookies: config.publicUrl.startsWith('https://'), publicUrl: config.publicUrl });
  }
  return api;
}
