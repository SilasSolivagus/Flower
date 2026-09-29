import { describe, expect, it } from 'vitest';
import { legacyUuid } from '../src/ids';
import { addDays, aliasKey, normTitle, parseJsonArray, parseLegacyDate, parseLegacyTime, splitNames, splitPlatforms } from '../src/normalize';

describe('确定性 ID', () => {
  it('同样的输入得到同样的 UUID，格式合法', () => {
    const a = legacyUuid('pan123/req', 'plane:X001');
    expect(a).toBe(legacyUuid('pan123/req', 'plane:X001'));
    expect(a).not.toBe(legacyUuid('other/req', 'plane:X001'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('归一化', () => {
  it('标题去掉空白和中英文标点后比较', () => {
    expect(normTitle(' 相册 归类！')).toBe(normTitle('相册归类'));
    expect(normTitle('Web（PC）端')).toBe('webpc端');
  });

  it('拆分多人与多平台写法', () => {
    expect(splitNames('王五、张三,李四 / 赵六')).toEqual(['王五', '张三', '李四', '赵六']);
    expect(splitNames(null)).toEqual([]);
    expect(splitPlatforms('PC客户端, Web端，小程序')).toEqual(['PC客户端', 'Web端', '小程序']);
    expect(parseJsonArray('["pc"," web ",""]')).toEqual(['pc', 'web']);
    expect(parseJsonArray('not json')).toEqual([]);
    expect(aliasKey(' Web 端 ')).toBe('web端');
  });

  it('解析旧系统的时间与日期写法（无时区的按 UTC）', () => {
    expect(parseLegacyTime('2026-03-30 06:00:56')?.toISOString()).toBe('2026-03-30T06:00:56.000Z');
    expect(parseLegacyTime('2026-03-12T07:32:56.636567+00:00')?.toISOString()).toBe('2026-03-12T07:32:56.636Z');
    expect(parseLegacyTime('2026-06-09T03:17:10.073Z')?.toISOString()).toBe('2026-06-09T03:17:10.073Z');
    expect(parseLegacyTime('2026-04-14')?.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(parseLegacyTime('2026-03-30T06:00:56')?.toISOString()).toBe('2026-03-30T06:00:56.000Z');
    expect(parseLegacyTime('2026-03-30T06:00:56+08:00')?.toISOString()).toBe('2026-03-29T22:00:56.000Z');
    expect(parseLegacyTime('2026-3-5 06:00')).toBeNull();
    expect(parseLegacyTime('2026-03-30  06:00:56')).toBeNull();
    expect(parseLegacyTime('')).toBeNull();
    expect(parseLegacyTime('坏数据')).toBeNull();
    expect(parseLegacyDate('2026-04-14T10:00:00Z')).toBe('2026-04-14');
    expect(parseLegacyDate('')).toBeNull();
    expect(addDays('2026-03-30', 3)).toBe('2026-04-02');
  });
});
