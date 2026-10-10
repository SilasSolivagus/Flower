import type { EmailConfig } from '../src/notifications/channel-config';
import type { HttpResult, Transport } from '../src/notifications/sender';

export type FakeCall = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
type Responder = (call: FakeCall) => HttpResult;

/** 假发送器：记录每次调用并按 responder 返回；不连任何网络。 */
export function fakeTransport(initial: Responder = () => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })) {
  let responder = initial;
  const calls: FakeCall[] = [];
  const mails: Array<{ to: string[]; subject: string; text: string }> = [];
  const transport: Transport = {
    async postJson(url, body, headers) {
      const call = { url, body: JSON.parse(body) as Record<string, unknown>, headers };
      calls.push(call);
      return responder(call);
    },
    async sendMail(cfg: EmailConfig, msg) {
      mails.push({ to: cfg.to, ...msg });
      return 'SMTP 已接受 1 个收件人';
    },
  };
  return {
    calls,
    mails,
    transport,
    reset(next: Responder) {
      responder = next;
      calls.length = 0;
      mails.length = 0;
    },
  };
}
