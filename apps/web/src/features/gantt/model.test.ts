import { describe, expect, it } from 'vitest';
import { parseHalfDays, parseProgress } from './model';

describe('甘特输入解析', () => {
  it('工期、延期以半天为单位；空表示未填；提示文字与服务端一致', () => {
    expect(parseHalfDays('', 0.5, '工期')).toEqual({ ok: true, value: null });
    expect(parseHalfDays(' 1.5 ', 0.5, '工期')).toEqual({ ok: true, value: 1.5 });
    expect(parseHalfDays('0.3', 0.5, '工期')).toEqual({ ok: false, message: '工期以半天为单位，范围 0.5–365 天' });
    expect(parseHalfDays('0', 0.5, '工期')).toEqual({ ok: false, message: '工期以半天为单位，范围 0.5–365 天' });
    expect(parseHalfDays('0', 0, '延期')).toEqual({ ok: true, value: 0 });
    expect(parseHalfDays('abc', 0, '延期')).toEqual({ ok: false, message: '延期以半天为单位，范围 0–365 天' });
  });

  it('手动进度：空表示按工期推算，否则为 0–100 的整数', () => {
    expect(parseProgress('')).toEqual({ ok: true, value: null });
    expect(parseProgress('60')).toEqual({ ok: true, value: 60 });
    expect(parseProgress('60.5')).toEqual({ ok: false, message: '进度应为 0–100 的整数' });
    expect(parseProgress('101')).toEqual({ ok: false, message: '进度应为 0–100 的整数' });
  });
});
