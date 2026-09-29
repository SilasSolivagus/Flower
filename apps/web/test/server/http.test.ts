import { describe, expect, it } from 'vitest';
import { clientIpFromForwardedFor } from '@/server/http';

describe('clientIpFromForwardedFor', () => {
  it('信任层数为 0 时忽略 X-Forwarded-For', () => {
    expect(clientIpFromForwardedFor('1.1.1.1, 2.2.2.2', 0)).toBeNull();
    expect(clientIpFromForwardedFor(undefined, 0)).toBeNull();
  });

  it('信任层数为 1 时取最右侧一项', () => {
    expect(clientIpFromForwardedFor('1.1.1.1, 2.2.2.2, 3.3.3.3', 1)).toBe('3.3.3.3');
  });

  it('信任层数为 2 时取倒数第二项', () => {
    expect(clientIpFromForwardedFor('1.1.1.1, 2.2.2.2, 3.3.3.3', 2)).toBe('2.2.2.2');
  });

  it('条目数少于信任层数时返回 null', () => {
    expect(clientIpFromForwardedFor('1.1.1.1', 2)).toBeNull();
    expect(clientIpFromForwardedFor(undefined, 1)).toBeNull();
  });
});
