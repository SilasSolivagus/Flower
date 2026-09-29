import { describe, expect, it } from 'vitest';
import { safeNext } from './next';

describe('safeNext', () => {
  it('accepts an in-app path', () => {
    expect(safeNext('/acme')).toBe('/acme');
  });

  it('rejects a protocol-relative URL', () => {
    expect(safeNext('//evil.com')).toBe('/');
  });

  it('rejects a backslash that browsers normalize into //', () => {
    expect(safeNext('/\\evil.com')).toBe('/');
  });

  it('rejects an absolute URL', () => {
    expect(safeNext('https://evil.com')).toBe('/');
  });

  it('defaults to / when null', () => {
    expect(safeNext(null)).toBe('/');
  });

  it('rejects a tab character that URL parsing strips into an external origin', () => {
    expect(safeNext('/\t/evil.com')).toBe('/');
  });

  it('rejects a newline character that URL parsing strips into an external origin', () => {
    expect(safeNext('/\n/evil.com')).toBe('/');
  });

  it('rejects a URL-encoded tab as decoded from searchParams', () => {
    // searchParams.get() 已经完成一次解码，%09 会变成真正的 tab 字符
    expect(safeNext(decodeURIComponent('/%09/evil.com'))).toBe('/');
  });
});
