import { describe, expect, it } from 'vitest';
import { backlinkViaLabel } from './model';

describe('「被引用」的来源说明', () => {
  it('需求描述、PRD 小节（无小节时为正文）、评论', () => {
    expect(backlinkViaLabel({ via: 'description', section: null })).toBe('需求描述');
    expect(backlinkViaLabel({ via: 'body', section: '1. 方案' })).toBe('小节「1. 方案」');
    expect(backlinkViaLabel({ via: 'body', section: null })).toBe('正文');
    expect(backlinkViaLabel({ via: 'comment', section: null })).toBe('评论');
  });
});
