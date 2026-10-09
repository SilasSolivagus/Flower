import { and, asc, eq, isNull } from 'drizzle-orm';
import { documents, entityAliases, entityLinks, iterations, products, requirements, structureNodes, tasks } from '../db/schema';
import type { Tx } from '../db/tx';
import { splitSections } from '../documents/markdown';
import { canonicalText, classifyTarget, linkContext, type LinkSourceType, type LinkTargetType, parseWikilinks } from './syntax';

export type LinkSource = { type: LinkSourceType; id: string; productKey: string };
export type ResolvedTarget = { targetType: LinkTargetType; targetId: string | null; targetSection: string | null; targetText: string };

type NodeRef = { id: string; parentId: string | null; name: string };

/** 一次重建内的解析器：缓存本组织的产品与各产品的结构树节点。在来源对象的写事务里使用（RLS 限定为本组织）。 */
class Resolver {
  private productByKey: Map<string, string> | null = null;
  private readonly nodesByProduct = new Map<string, NodeRef[]>();

  constructor(private readonly tx: Tx) {}

  private async productId(key: string): Promise<string | null> {
    if (!this.productByKey) {
      const rows = await this.tx.select({ id: products.id, key: products.key }).from(products).where(isNull(products.deletedAt));
      this.productByKey = new Map(rows.map((p) => [p.key, p.id]));
    }
    return this.productByKey.get(key.toUpperCase()) ?? null;
  }

  private async node(productId: string, path: string[]): Promise<string | null> {
    if (path.length === 0) return null;
    let all = this.nodesByProduct.get(productId);
    if (!all) {
      all = await this.tx
        .select({ id: structureNodes.id, parentId: structureNodes.parentId, name: structureNodes.name })
        .from(structureNodes)
        .where(eq(structureNodes.productId, productId));
      this.nodesByProduct.set(productId, all);
    }
    let parent: string | null = null;
    for (const name of path) {
      const hit = all.find((n) => n.parentId === parent && n.name === name);
      if (!hit) return null;
      parent = hit.id;
    }
    return parent;
  }

  private async alias(text: string): Promise<string | null> {
    const [a] = await this.tx
      .select({ id: entityAliases.entityId })
      .from(entityAliases)
      .where(and(eq(entityAliases.alias, text), eq(entityAliases.entityType, 'requirement')));
    return a?.id ?? null;
  }

  async resolve(target: string, sourceProductKey: string): Promise<ResolvedTarget> {
    const t = classifyTarget(target);
    const targetText = canonicalText(t, sourceProductKey);
    const out = (targetType: LinkTargetType, targetId: string | null, targetSection: string | null = null): ResolvedTarget => ({ targetType, targetId, targetSection, targetText });
    switch (t.kind) {
      case 'requirement': {
        const pid = await this.productId(t.productKey);
        const [r] = pid
          ? await this.tx.select({ id: requirements.id }).from(requirements).where(and(eq(requirements.productId, pid), eq(requirements.number, t.number)))
          : [];
        return out('requirement', r?.id ?? (await this.alias(target.trim())));
      }
      case 'document': {
        const pid = await this.productId(t.productKey);
        const [d] = pid ? await this.tx.select({ id: documents.id }).from(documents).where(and(eq(documents.productId, pid), eq(documents.number, t.number))) : [];
        return out('document', d?.id ?? null, t.section);
      }
      case 'task': {
        const pid = await this.productId(t.productKey);
        const [x] = pid ? await this.tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.productId, pid), eq(tasks.number, t.number))) : [];
        return out('task', x?.id ?? null);
      }
      case 'iteration': {
        const pid = await this.productId(t.productKey ?? sourceProductKey);
        const [own] = pid
          ? await this.tx
              .select({ id: iterations.id })
              .from(iterations)
              .where(and(eq(iterations.productId, pid), eq(iterations.name, t.name), isNull(iterations.deletedAt)))
          : [];
        if (own) return out('iteration', own.id);
        const [special] = await this.tx
          .select({ id: iterations.id })
          .from(iterations)
          .where(and(eq(iterations.type, 'special'), eq(iterations.name, t.name), isNull(iterations.deletedAt)))
          .orderBy(asc(iterations.createdAt))
          .limit(1);
        return out('iteration', special?.id ?? null);
      }
      case 'path': {
        if (t.segments.length === 1) {
          const aliased = await this.alias(t.segments[0]!);
          if (aliased) return out('requirement', aliased);
        }
        const [head, ...rest] = targetText.split('/');
        const pid = await this.productId(head!);
        let id = pid ? await this.node(pid, rest) : null;
        // 首段形似产品前缀、但没有这个产品时，按来源产品内的完整路径再找一次（如名为「API」的业务域）
        if (!id && !pid) {
          const own = await this.productId(sourceProductKey);
          id = own ? await this.node(own, t.segments) : null;
        }
        return out('structure_node', id);
      }
    }
  }
}

/** PRD 正文里各小节的起始位置与原始标题（第一个标题之前的内容标题为空）。 */
function sectionStarts(body: string): Array<{ start: number; heading: string | null }> {
  const out: Array<{ start: number; heading: string | null }> = [];
  let at = 0;
  for (const s of splitSections(body)) {
    const start = body.indexOf(s.markdown, at);
    out.push({ start, heading: s.heading });
    at = start + s.markdown.length;
  }
  return out;
}

/**
 * 重建一个来源的 [[ ]] 链接：删除该来源全部 wikilink 行后按正文重新解析写入，在来源对象的写事务里调用。
 * 同一小节内指向同一规范写法的只记一条；已存在的组合保留原来的 created_at（「被引用」显示第一次引用的时间）。
 */
export async function syncSourceLinks(tx: Tx, orgId: string, source: LinkSource, text: string, opts: { markdown?: boolean } = {}): Promise<number> {
  const body = text.replace(/\r\n?/g, '\n');
  const mine = and(eq(entityLinks.sourceType, source.type), eq(entityLinks.sourceId, source.id), eq(entityLinks.origin, 'wikilink'));
  const before = await tx.select({ sourceSection: entityLinks.sourceSection, targetText: entityLinks.targetText, createdAt: entityLinks.createdAt }).from(entityLinks).where(mine);
  const firstSeen = new Map(before.map((r) => [`${r.sourceSection ?? ''}\u0000${r.targetText}`, r.createdAt]));
  await tx.delete(entityLinks).where(mine);
  const sections = opts.markdown ? sectionStarts(body) : [];
  const resolver = new Resolver(tx);
  const seen = new Set<string>();
  const values: Array<typeof entityLinks.$inferInsert> = [];
  for (const link of parseWikilinks(body)) {
    const sourceSection = sections.filter((s) => s.start <= link.start).at(-1)?.heading ?? null;
    const resolved = await resolver.resolve(link.target, source.productKey);
    const key = `${sourceSection ?? ''}\u0000${resolved.targetText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      orgId,
      sourceType: source.type,
      sourceId: source.id,
      sourceSection,
      ...resolved,
      context: linkContext(body, link.start, link.end),
      origin: 'wikilink',
      createdAt: firstSeen.get(key) ?? new Date(),
    });
  }
  if (values.length > 0) await tx.insert(entityLinks).values(values);
  return values.length;
}
