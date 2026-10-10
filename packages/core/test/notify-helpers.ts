import type { Db } from '../src/db/client';
import type { Actor } from '../src/domain-types';
import { type ChannelView, createChannel } from '../src/notifications/channels';

// 通道登记时会校验网址不指向本机或内网地址（见 notifications/channel-config.ts 的 assertSafeOutboundUrl）；
// 本文件下面的测试夹具地址故意指向本机不可达端口，跳过该检查。真正的发送仍然经注入的 Transport，不会真的发出。
process.env.FLOWER_NOTIFY_ALLOW_PRIVATE = '1';

export const TEST_SECRET = 'notify-test-secret-notify-test-secret-0001';
export const TEST_DEPS = { secretKey: TEST_SECRET, publicUrl: 'http://flower.example.com' };
/** 指向本机不可达端口的虚构地址；测试里的发送一律经注入的 Transport，不会真的发出。 */
export const WECOM_URL = 'http://127.0.0.1:9/cgi-bin/webhook/send?key=demo-key-0001';

export function wecomChannel(
  db: Db,
  actor: Actor,
  name: string,
  extra: { allowedProductIds?: string[]; enabled?: boolean; rateLimitPerMin?: number; url?: string } = {},
): Promise<ChannelView> {
  return createChannel(
    db,
    actor,
    { kind: 'wecom_robot', name, config: { url: extra.url ?? WECOM_URL }, allowedProductIds: extra.allowedProductIds, enabled: extra.enabled, rateLimitPerMin: extra.rateLimitPerMin },
    TEST_DEPS,
  );
}
