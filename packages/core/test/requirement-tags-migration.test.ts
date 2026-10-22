import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_URL, APP_PASSWORD, urlFor } from './db';

const dir = path.join(import.meta.dirname, '../migrations');
const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

/** 0000–0023 必须和合入前逐字一致。改其中任何一条，这条测试就失败。 */
const FROZEN = [
  ['0000_roles', 1790580813298],
  ['0001_init', 1790580816103],
  ['0002_rls', 1790580818930],
  ['0003_events_append_only', 1790592964282],
  ['0004_auth_throttle', 1790651535612],
  ['0005_exotic_guardian', 1790678551548],
  ['0006_p1a_rls', 1790678555934],
  ['0007_powerful_frog_thor', 1790686275812],
  ['0008_overconfident_salo', 1790749643307],
  ['0009_windy_squadron_sinister', 1791443757110],
  ['0010_p2a_rls', 1791443764134],
  ['0011_friendly_zarda', 1791513645869],
  ['0012_p2b1_rls', 1791513655196],
  ['0013_open_tigra', 1791541136836],
  ['0014_p2b2_rls', 1791541139562],
  ['0015_free_nicolaos', 1791619648427],
  ['0016_p3a_rls', 1791619660803],
  ['0017_young_pandemic', 1791791699994],
  ['0018_p3b1_rls', 1791791706361],
  ['0019_flippant_titanium_man', 1791948217479],
  ['0020_p3c1_tracking', 1791948217905],
  ['0021_slimy_violations', 1792114091863],
  ['0022_p3c2_briefs', 1792114094635],
  ['0023_p3c2_ux_copy', 1792401600000],
] as const;

const downName = '0024_requirement_tags.down.sql';
let roundtripDb: string | null = null;

async function adminExec(statement: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

afterAll(async () => {
  if (roundtripDb) await adminExec(`DROP DATABASE IF EXISTS ${roundtripDb} WITH (FORCE)`);
});

describe('0024 迁移白名单', () => {
  it('只追加一条 0024，旧条目不动，down 不进 journal', () => {
    expect(journal.entries).toHaveLength(25);
    journal.entries.slice(0, 24).forEach((entry, i) => {
      expect(entry).toMatchObject({ idx: i, version: '7', tag: FROZEN[i]![0], when: FROZEN[i]![1], breakpoints: true });
    });
    expect(journal.entries[24]).toMatchObject({ idx: 24, version: '7', when: 1792502400000, tag: '0024_requirement_tags', breakpoints: true });
    const sqlFiles = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
    const expected = [...journal.entries.map((e) => `${e.tag}.sql`), downName].sort();
    expect(sqlFiles).toEqual(expected);
    expect(readdirSync(path.join(dir, 'meta'))).toContain('0024_snapshot.json');
    const up = readFileSync(path.join(dir, '0024_requirement_tags.sql'), 'utf8');
    const alters = [...up.matchAll(/ALTER TABLE\s+"?([a-z0-9_]+)"?/gi)].map((m) => m[1]);
    expect([...new Set(alters)].sort()).toEqual(['requirement_tag_links', 'requirement_tags']);
    expect(up).toContain('ENABLE ROW LEVEL SECURITY');
    expect(up).not.toMatch(/ALTER TABLE "(requirements|documents|work_items|function_tags)"/i);
    const down = readFileSync(path.join(dir, downName), 'utf8');
    expect(down).toContain('DELETE FROM "drizzle"."__drizzle_migrations"');
    expect(down).toContain('1792502400000');
  });

  it('在独立库上 up → down → up', async () => {
    roundtripDb = `flower_mig_${Date.now().toString(36)}`;
    await adminExec(`CREATE DATABASE ${roundtripDb}`);
    const url = urlFor(ADMIN_URL, roundtripDb);
    await runMigrations(url, APP_PASSWORD);
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const tables = async () =>
        client`select tablename from pg_tables where schemaname = 'public' and tablename in ('requirement_tags', 'requirement_tag_links') order by tablename`;
      expect((await tables()).map((r) => r.tablename)).toEqual(['requirement_tag_links', 'requirement_tags']);
      const rls = await client`
        select relname, relrowsecurity from pg_class where relname in ('requirement_tags', 'requirement_tag_links') order by relname`;
      expect(rls.every((r) => r.relrowsecurity)).toBe(true);
      await client.unsafe(readFileSync(path.join(dir, downName), 'utf8'));
      expect(await tables()).toEqual([]);
      const left = await client`select created_at from drizzle.__drizzle_migrations where created_at = 1792502400000`;
      expect(left).toEqual([]);
    } finally {
      await client.end();
    }
    await runMigrations(url, APP_PASSWORD);
    const again = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const tables = await again`select tablename from pg_tables where schemaname = 'public' and tablename in ('requirement_tags', 'requirement_tag_links') order by tablename`;
      expect(tables.map((r) => r.tablename)).toEqual(['requirement_tag_links', 'requirement_tags']);
    } finally {
      await again.end();
    }
  });
});
