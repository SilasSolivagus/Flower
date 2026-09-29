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
});
