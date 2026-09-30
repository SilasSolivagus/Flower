import { describe, expect, it } from 'vitest';
import { legacyUuid } from '../src/ids';
import { addDays, aliasKey, normTitle, parseJsonArray, parseLegacyDate, parseLegacyTime, parsePersonName, splitNames, splitPlatforms } from '../src/normalize';

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

  it('两个汉字之间的空白也算多人分隔，其他空白不拆', () => {
    expect(splitNames('王五、赵六 钱七')).toEqual(['王五', '赵六', '钱七']);
    expect(splitNames('王五 、 赵六  、、 钱七')).toEqual(['王五', '赵六', '钱七']);
    expect(splitNames('Alex Chen')).toEqual(['Alex Chen']);
    expect(splitNames('代饶总 by 张三')).toEqual(['代饶总 by 张三']);
  });

  it('解析「头衔-姓名(昵称)」「姓名（昵称）」；姓名不是 2–4 个汉字时原样返回', () => {
    expect(parsePersonName('产品经理-李四(小李)')).toEqual({ name: '李四', title: '产品经理', nickname: '小李' });
    expect(parsePersonName('运营-孙八')).toEqual({ name: '孙八', title: '运营', nickname: null });
    expect(parsePersonName('周小雨（雨雨）')).toEqual({ name: '周小雨', title: null, nickname: '雨雨' });
    expect(parsePersonName(' 王五 ')).toEqual({ name: '王五', title: null, nickname: null });
    expect(parsePersonName('市场-Amy')).toEqual({ name: '市场-Amy', title: null, nickname: null });
    expect(parsePersonName('data-sync')).toEqual({ name: 'data-sync', title: null, nickname: null });
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
    // 半天不截断：结束落在当天中午，按结束日的次日计
    expect(addDays('2026-03-02', 0.5)).toBe('2026-03-03');
    expect(addDays('2026-03-02', 2)).toBe('2026-03-04');
    expect(addDays('2026-03-02', 1.5)).toBe('2026-03-04');
  });
});
