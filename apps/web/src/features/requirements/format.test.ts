import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, stateLabel } from './format';

describe('详情页格式化', () => {
  it('日期按本地时区输出', () => {
    const iso = new Date(2026, 2, 5, 9, 7).toISOString();
    expect(formatDateTime(iso)).toBe('2026-03-05 09:07');
    expect(formatDate(iso)).toBe('2026-03-05');
  });

  it('状态名找不到时显示 key', () => {
    const states = [{ key: 'collect', label: '收集' }];
    expect(stateLabel(states, 'collect')).toBe('收集');
    expect(stateLabel(states, 'gone')).toBe('gone');
    expect(stateLabel(states, null)).toBe('（创建）');
  });
});
