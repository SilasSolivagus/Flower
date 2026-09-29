import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { accounts, createDb, listProducts, resolveActor } from '@flower/core';
import { eq } from 'drizzle-orm';
import type { LegacyData } from './legacy-types';
import { loadPlane, loadPrd, loadPush } from './load';
import { readMapping, writeMapping } from './mapping';
import { buildImportPlan } from './plan';
import { buildPerfCases, measure } from './perf';
import { renderReport } from './report';
import { suggestMapping } from './suggest';
import { writeImport } from './write';

const USAGE = `用法：
  suggest --plane <123plane.db> --push <push.db> --prd-url <postgres url> --mapping <目录>
  import  --plane … --push … --prd-url … --mapping <目录> --out <报告目录> [--org-slug pan123] [--org-name 123云盘]
          [--product-key PAN] [--product-name 123云盘] [--as-of YYYY-MM-DD] [--owner-email 邮箱] [--replace] [--dry-run]
  perf --org-slug pan123 --owner-email 邮箱 [--product-key PAN] [--runs 20]（读取 DATABASE_URL）
import 写库时读取环境变量 DATABASE_ADMIN_URL。`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const { values: v } = parseArgs({
    args,
    options: {
      plane: { type: 'string' },
      push: { type: 'string' },
      'prd-url': { type: 'string' },
      mapping: { type: 'string' },
      out: { type: 'string' },
      'org-slug': { type: 'string', default: 'pan123' },
      'org-name': { type: 'string', default: '123云盘' },
      'product-key': { type: 'string', default: 'PAN' },
      'product-name': { type: 'string', default: '123云盘' },
      'as-of': { type: 'string', default: new Date().toISOString().slice(0, 10) },
      'owner-email': { type: 'string' },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      runs: { type: 'string', default: '20' },
    },
  });
  const need = (k: 'plane' | 'push' | 'prd-url' | 'mapping' | 'out') => v[k] ?? fail(`缺少参数 --${k}`);

  if (cmd === 'perf') {
    const url = process.env.DATABASE_URL ?? fail('perf 需要 DATABASE_URL（运行时角色）');
    const email = v['owner-email'] ?? fail('缺少参数 --owner-email');
    const { db, close } = createDb(url, { max: 2 });
    try {
      const [a] = await db.select().from(accounts).where(eq(accounts.email, email.trim().toLowerCase()));
      if (!a) fail(`找不到账号 ${email}`);
      const actor = (await resolveActor(db, a.id, v['org-slug']!)) ?? fail(`账号 ${email} 不是组织 ${v['org-slug']} 的成员`);
      const products = await listProducts(db, actor);
      const product = products.find((p) => p.key === v['product-key']) ?? fail(`找不到产品 ${v['product-key']}`);
      const result = await measure(await buildPerfCases(db, actor, product.id), Number(v.runs));
      console.log('| 用例 | p50 (ms) | p95 (ms) | 最大 (ms) |\n|---|---|---|---|');
      for (const r of result) console.log(`| ${r.name} | ${r.p50} | ${r.p95} | ${r.max} |`);
    } finally {
      await close();
    }
    return;
  }

  const data: LegacyData = { plane: loadPlane(need('plane')), push: loadPush(need('push')), prd: await loadPrd(need('prd-url')) };
  const mappingDir = need('mapping');

  if (cmd === 'suggest') {
    const m = suggestMapping(data, readMapping(mappingDir));
    writeMapping(mappingDir, m);
    console.log(
      `已写入对照表 ${mappingDir}：人员 ${m.people.people.length}、平台选项 ${m.platforms.options.length}、业务域 ${m.domains.nodes.length}、迭代 ${m.iterations.iterations.length}。请审阅后运行 import。`,
    );
    return;
  }
  if (cmd !== 'import') fail(`未知命令：${cmd ?? '（空）'}`);

  const mapping = readMapping(mappingDir) ?? fail(`对照表目录 ${mappingDir} 不完整，先运行 suggest`);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  let owner: { accountId: string; email: string; name: string } | null = null;
  if (v['owner-email']) {
    if (!adminUrl) fail('指定 --owner-email 时需要 DATABASE_ADMIN_URL 来查找账号');
    const { db, close } = createDb(adminUrl, { max: 1 });
    try {
      const [a] = await db.select().from(accounts).where(eq(accounts.email, v['owner-email'].trim().toLowerCase()));
      if (!a) fail(`找不到账号 ${v['owner-email']}`);
      owner = { accountId: a.id, email: a.email, name: a.name };
    } finally {
      await close();
    }
  }
  const plan = buildImportPlan(data, mapping, {
    orgSlug: v['org-slug']!,
    orgName: v['org-name']!,
    productKey: v['product-key']!,
    productName: v['product-name']!,
    asOf: v['as-of']!,
    owner,
  });
  const out = need('out');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'migration-report.md'), renderReport(plan.report));
  writeFileSync(path.join(out, 'migration-report.json'), `${JSON.stringify(plan.report, null, 2)}\n`);
  console.log(`对账报告：${path.join(out, 'migration-report.md')}`);
  if (plan.report.problems.length > 0) {
    console.error(`有 ${plan.report.problems.length} 个问题，未写入数据库。`);
    process.exitCode = 1;
    return;
  }
  if (v['dry-run']) {
    console.log('试跑完成，未写入数据库。');
    return;
  }
  if (!adminUrl) fail('写入数据库需要 DATABASE_ADMIN_URL');
  const { db, close } = createDb(adminUrl, { max: 2 });
  try {
    await writeImport(db, plan, { replace: v.replace! });
  } finally {
    await close();
  }
  console.log(`已写入组织 ${plan.rows.organizations[0]!.slug}：需求 ${plan.rows.requirements.length} 条。`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
