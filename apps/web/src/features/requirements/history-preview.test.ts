import { describe, expect, it } from 'vitest';
import { HISTORY_PREVIEW_COUNT, previewHistory } from './history-preview';

describe('状态历史预览', () => {
  it('默认只留最近 3 条，展开后按新到旧给出全部', () => {
    const oldestFirst = ['创建', '收集→待开发', '待开发→开发中', '开发中→已上线', '已上线→复盘'];
    expect(HISTORY_PREVIEW_COUNT).toBe(3);
    expect(previewHistory(oldestFirst, false)).toEqual({
      visible: ['已上线→复盘', '开发中→已上线', '待开发→开发中'],
      hiddenCount: 2,
    });
    expect(previewHistory(oldestFirst, true)).toEqual({
      visible: ['已上线→复盘', '开发中→已上线', '待开发→开发中', '收集→待开发', '创建'],
      hiddenCount: 0,
    });
    expect(oldestFirst).toEqual(['创建', '收集→待开发', '待开发→开发中', '开发中→已上线', '已上线→复盘']);
  });

  it('不足 3 条时不隐藏', () => {
    expect(previewHistory(['创建', '收集→待开发'], false)).toEqual({
      visible: ['收集→待开发', '创建'],
      hiddenCount: 0,
    });
    expect(previewHistory([], false)).toEqual({ visible: [], hiddenCount: 0 });
  });
});
