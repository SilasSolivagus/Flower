import { AppError } from '../errors';
import type { ChannelKind, ChannelPayload, DeliveryPayload, TemplateFormat } from './constants';

type Node = { t: 'text'; v: string } | { t: 'var'; path: string } | { t: 'section'; path: string; inverted: boolean; children: Node[] };

const TAG = /\{\{\s*([#^/]?)\s*([\w.]+)\s*\}\}/g;
/** 独占一行的区块标签（{{#x}}、{{^x}}、{{/x}}）连同行尾换行一起去掉，模板可以按行书写。 */
const STANDALONE = /^[ \t]*(\{\{\s*[#^/]\s*[\w.]+\s*\}\})[ \t]*(?:\r?\n|$)/gm;

function parseTemplate(body: string): Node[] {
  const src = body.replace(STANDALONE, '$1');
  const root: Node[] = [];
  const stack: Array<{ path: string; children: Node[] }> = [{ path: '', children: root }];
  let last = 0;
  for (const m of src.matchAll(TAG)) {
    const top = stack.at(-1)!;
    if (m.index > last) top.children.push({ t: 'text', v: src.slice(last, m.index) });
    last = m.index + m[0].length;
    const sigil = m[1];
    const path = m[2]!;
    if (sigil === '#' || sigil === '^') {
      const node: Node = { t: 'section', path, inverted: sigil === '^', children: [] };
      top.children.push(node);
      stack.push({ path, children: node.children });
    } else if (sigil === '/') {
      if (stack.length === 1 || top.path !== path) throw new AppError('invalid', `模板语法错误：{{/${path}}} 没有对应的开始标签`);
      stack.pop();
    } else {
      top.children.push({ t: 'var', path });
    }
  }
  if (stack.length > 1) {
    const open = stack.at(-1)!.path;
    throw new AppError('invalid', `模板语法错误：{{#${open}}} 没有对应的 {{/${open}}}`);
  }
  if (last < src.length) root.push({ t: 'text', v: src.slice(last) });
  return root;
}

/** 从内到外查找路径的第一段，找到所在的上下文后按点号取值。只读自身属性，不沿原型链（`{{constructor}}` 等为空）。 */
function lookup(stack: unknown[], path: string): unknown {
  const parts = path.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx !== null && typeof ctx === 'object' && !Array.isArray(ctx) && Object.hasOwn(ctx, parts[0]!)) {
      let v: unknown = ctx;
      for (const p of parts) v = v !== null && typeof v === 'object' && Object.hasOwn(v, p) ? (v as Record<string, unknown>)[p] : undefined;
      return v;
    }
  }
  return undefined;
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0);
const toText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

function render(nodes: Node[], stack: unknown[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'var') out += toText(lookup(stack, n.path));
    else {
      const v = lookup(stack, n.path);
      if (n.inverted) {
        if (isEmpty(v)) out += render(n.children, stack);
      } else if (Array.isArray(v)) {
        for (const item of v) out += render(n.children, [...stack, item]);
      } else if (!isEmpty(v)) {
        out += render(n.children, [...stack, v]);
      }
    }
  }
  return out;
}

/** {{path}} 字段替换；{{#path}}…{{/path}} 按列表重复或在非空时渲染；{{^path}}…{{/path}} 在为空时渲染。不执行代码。 */
export function renderTemplate(body: string, data: Record<string, unknown>): string {
  return render(parseTemplate(body), [data]);
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

function parseCard(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('invalid', '模板卡片的内容应为 JSON 对象');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('invalid', '模板卡片的内容应为 JSON 对象');
  return parsed as Record<string, unknown>;
}

export function assertTemplateBody(format: TemplateFormat, body: string): void {
  if (format === 'template_card') {
    mapStrings(parseCard(body), (s) => {
      parseTemplate(s);
      return s;
    });
  } else {
    parseTemplate(body);
  }
}

export type RenderedMessage = { format: 'text' | 'markdown' | 'email'; text: string } | { format: 'template_card'; card: Record<string, unknown> };

export function renderMessage(format: TemplateFormat, body: string, data: Record<string, unknown>): RenderedMessage {
  if (format === 'template_card') return { format, card: mapStrings(parseCard(body), (s) => renderTemplate(s, data)) as Record<string, unknown> };
  return { format, text: renderTemplate(body, data).trim() };
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 企微 markdown 单条消息的字节上限。 */
export const WECOM_MARKDOWN_MAX_BYTES = 4096;
/** 只发一条的消息超出上限时，截断处的说明。 */
export const TRUNCATED_MARK = '…（内容过长，已截断）';

/** 按 UTF-8 字节截断，超出时以 mark（默认「…」）结尾，结果不超过 maxBytes。 */
export function truncateBytes(s: string, maxBytes: number, mark = '…'): string {
  if (bytes(s) <= maxBytes) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (n + b > maxBytes - bytes(mark)) break;
    out += ch;
    n += b;
  }
  return `${out}${mark}`;
}

/**
 * 企微 markdown 每条最多 4096 字节：按空行分段装箱；第一行是标题（以 # 开头）时，
 * 第 2 条起标题加「（续n）」。单段过长时截断。
 */
export function splitMarkdown(text: string, maxBytes = WECOM_MARKDOWN_MAX_BYTES): string[] {
  if (bytes(text) <= maxBytes) return [text];
  const firstNL = text.indexOf('\n');
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  const heading = firstLine.startsWith('#') ? firstLine : null;
  const rest = heading === null ? text : text.slice(firstNL + 1).replace(/^\n+/, '');
  const paras = rest.split(/\n{2,}/).filter((p) => p.trim() !== '');
  const head = (i: number): string => (heading === null ? '' : i === 0 ? heading : `${heading}（续${i + 1}）`);
  const compose = (i: number, parts: string[]): string => [head(i), ...parts].filter(Boolean).join('\n\n');
  const chunks: string[] = [];
  let body: string[] = [];
  for (const p of paras) {
    if (bytes(compose(chunks.length, [...body, p])) <= maxBytes) {
      body.push(p);
      continue;
    }
    if (body.length > 0) {
      chunks.push(compose(chunks.length, body));
      body = [];
    }
    if (bytes(compose(chunks.length, [p])) <= maxBytes) body.push(p);
    else chunks.push(truncateBytes(compose(chunks.length, [p]), maxBytes));
  }
  if (body.length > 0 || chunks.length === 0) chunks.push(compose(chunks.length, body));
  return chunks;
}

const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), obj);

const cardLinks = (card: Record<string, unknown>): string[] => {
  const list = Array.isArray(card.jump_list) ? card.jump_list : [];
  return list.map((j) => `${toText(get(j, 'title'))}：${toText(get(j, 'url'))}`);
};

const subjectLine = (text: string): string =>
  (text.split('\n').find((l) => l.trim() !== '') ?? '')
    .replace(/^[#>\s*]+/, '')
    .replace(/\*+$/, '')
    .trim();

/** 渲染结果 → 通道的请求体。企微 markdown 可能拆成多条，其余都是一条。 */
export function toChannelPayloads(kind: ChannelKind, msg: RenderedMessage): ChannelPayload[] {
  if (kind === 'email') {
    if (msg.format === 'template_card') {
      const lines = [toText(get(msg.card, 'main_title.desc')), ...cardLinks(msg.card)].filter(Boolean);
      return [{ type: 'email', subject: toText(get(msg.card, 'main_title.title')) || 'Flower 推送', text: lines.join('\n') }];
    }
    if (msg.format === 'email') {
      const [first, ...rest] = msg.text.split('\n');
      return [{ type: 'email', subject: first!.trim() || 'Flower 推送', text: rest.join('\n').trim() }];
    }
    return [{ type: 'email', subject: subjectLine(msg.text) || 'Flower 推送', text: msg.text }];
  }
  if (kind === 'webhook') {
    return [{ type: 'json', body: msg.format === 'template_card' ? { format: msg.format, content: msg.card } : { format: msg.format, content: msg.text } }];
  }
  if (msg.format === 'template_card') return [{ type: 'json', body: { msgtype: 'template_card', template_card: msg.card } }];
  if (msg.format === 'markdown') return splitMarkdown(msg.text).map((content) => ({ type: 'json' as const, body: { msgtype: 'markdown', markdown: { content } } }));
  return [{ type: 'json', body: { msgtype: 'text', text: { content: truncateBytes(msg.text, 2048) } } }];
}

/** 发送记录页的内容摘要（最多 200 字），不含任何通道配置。 */
export function payloadPreview(payload: DeliveryPayload | null): string {
  if (!payload) return '（发送前渲染）';
  let text: string;
  if (payload.type === 'legacy') text = payload.content;
  else if (payload.type === 'email') text = payload.subject;
  else {
    const b = payload.body;
    const card = b.msgtype === 'template_card' ? b.template_card : b.format === 'template_card' ? b.content : null;
    if (card) text = [toText(get(card, 'main_title.title')), toText(get(card, 'main_title.desc'))].filter(Boolean).join(' · ');
    else text = toText(get(b, 'markdown.content')) || toText(get(b, 'text.content')) || toText(b.content);
  }
  return text.slice(0, 200);
}
