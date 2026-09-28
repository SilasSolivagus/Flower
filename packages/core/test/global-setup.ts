import postgres from 'postgres';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_URL, APP_PASSWORD, TEMPLATE_DB, urlFor } from './db';

async function exec(statement: string) {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

export default async function setup() {
  await exec(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await exec(`CREATE DATABASE ${TEMPLATE_DB}`);
  await runMigrations(urlFor(ADMIN_URL, TEMPLATE_DB), APP_PASSWORD);
  return async () => {
    await exec(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  };
}
