import { and, eq } from 'drizzle-orm';
import { notificationChannels, notificationDeliveries, organizations, products } from '../db/schema';
import type { Tx } from '../db/tx';
import { usableChannelsTx } from '../notifications/channels';
import { truncateBytes, WECOM_MARKDOWN_MAX_BYTES } from '../notifications/template';

/** 一条要发到企业微信或邮件的个人提醒（站内通知之外）。url 为站内相对路径。 */
export type OutboundItem = {
  productId: string | null;
  memberId: string;
  email: string | null;
  wecomUserid: string | null;
  viaWecom: boolean;
  viaEmail: boolean;
  actorName: string | null;
  body: string;
  title: string;
  url: string;
};

const absolute = (publicUrl: string, url: string): string => `${publicUrl.replace(/\/+$/, '')}${url}`;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 企业微信个人提醒的一行：`<@userid> 操作人 动作：[编号 标题](链接)`。标题里的方括号换成空格，免得破坏链接写法。 */
export function wecomLine(i: OutboundItem, publicUrl: string): string {
  return `<@${i.wecomUserid}> ${i.actorName ?? '系统'} ${i.body}：[${i.title.replace(/[[\]]/g, ' ')}](${absolute(publicUrl, i.url)})`;
}

/** 按行合并成若干条，每条不超过 maxBytes；单行超长时截断。 */
export function chunkLines(lines: string[], maxBytes = WECOM_MARKDOWN_MAX_BYTES): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    const line = bytes(raw) > maxBytes ? truncateBytes(raw, maxBytes) : raw;
    const next = cur ? `${cur}\n${line}` : line;
    if (bytes(next) <= maxBytes) {
      cur = next;
      continue;
    }
    out.push(cur);
    cur = line;
  }
  if (cur) out.push(cur);
  return out;
}

/** 一个人这一轮的邮件：主题带条数，每条两行（动作与链接）。 */
export function emailFor(items: OutboundItem[], publicUrl: string): { subject: string; text: string } {
  const entries = items.map((i) => `${i.actorName ?? '系统'} ${i.body}：${i.title}\n${absolute(publicUrl, i.url)}`);
  return { subject: `Flower：你有 ${items.length} 条新通知`, text: `${entries.join('\n\n')}\n\n在 Flower 的个人设置里可以修改通知偏好。` };
}

/**
 * 把一轮的个人提醒写进 P3-A 的发送队列（kind = personal，请求体已渲染）：
 * 企业微信按产品合并，发到该产品的个人提醒通道（未指定、停用或不再允许本产品使用时不发）；
 * 邮件按人合并，发到组织的个人通知邮件通道（未指定或停用时不发），收件地址为成员邮箱。
 */
export async function dispatchPersonalTx(tx: Tx, orgId: string, items: OutboundItem[], publicUrl: string, now: Date): Promise<{ wecom: number; email: number }> {
  let wecom = 0;
  let email = 0;
  const byProduct = new Map<string, OutboundItem[]>();
  for (const i of items) if (i.viaWecom && i.wecomUserid && i.productId) byProduct.set(i.productId, [...(byProduct.get(i.productId) ?? []), i]);
  for (const [productId, list] of byProduct) {
    const [p] = await tx.select({ channelId: products.personalChannelId }).from(products).where(eq(products.id, productId));
    if (!p?.channelId) continue;
    const [ch] = (await usableChannelsTx(tx, [p.channelId], productId)).filter((c) => c.kind === 'wecom_robot');
    if (!ch) continue;
    for (const content of chunkLines(list.map((i) => wecomLine(i, publicUrl)))) {
      await tx.insert(notificationDeliveries).values({
        orgId,
        kind: 'personal',
        channelId: ch.id,
        payload: { type: 'json', body: { msgtype: 'markdown', markdown: { content } } },
        status: 'pending',
        nextAttemptAt: now,
      });
      wecom += 1;
    }
  }
  const byMember = new Map<string, OutboundItem[]>();
  for (const i of items) if (i.viaEmail && i.email) byMember.set(i.memberId, [...(byMember.get(i.memberId) ?? []), i]);
  if (byMember.size > 0) {
    const [org] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, orgId));
    const [ch] = org?.channelId
      ? await tx
          .select({ id: notificationChannels.id })
          .from(notificationChannels)
          .where(and(eq(notificationChannels.id, org.channelId), eq(notificationChannels.kind, 'email'), eq(notificationChannels.enabled, true)))
      : [];
    if (ch) {
      for (const list of byMember.values()) {
        const msg = emailFor(list, publicUrl);
        await tx.insert(notificationDeliveries).values({
          orgId,
          kind: 'personal',
          channelId: ch.id,
          payload: { type: 'email', subject: msg.subject, text: msg.text, to: [list[0]!.email!] },
          status: 'pending',
          nextAttemptAt: now,
        });
        email += 1;
      }
    }
  }
  return { wecom, email };
}
