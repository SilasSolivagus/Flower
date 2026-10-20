import { describe, expect, it } from 'vitest';
import { briefSectionFolds, briefSectionKey } from './brief-sections';

const template = ['## 1. 问题与目标', '', '在这里写问题', '', '## 2. 数据依据', '', '在这里写依据', ''].join('\n');

describe('简报小节折叠', () => {
  it('标题键去掉编号和编辑器反斜杠', () => {
    expect(briefSectionKey('1\\. 问题与目标')).toBe(briefSectionKey('1. 问题与目标'));
    expect(briefSectionKey('14. 分工')).toBe('分工');
  });

  it('模板原样算未填；写了理由的不适用算已填并标不适用；只写不适用算未填', () => {
    expect(briefSectionFolds(template, template).map((s) => s.unfilled)).toEqual([true, true]);
    const md = ['## 1. 问题与目标', '', '不适用：没有多对象', '', '## 2. 数据依据', '', '不适用：', ''].join('\n');
    expect(briefSectionFolds(md, template)).toEqual([
      { heading: '1. 问题与目标', key: '问题与目标', unfilled: false, notApplicable: true },
      { heading: '2. 数据依据', key: '数据依据', unfilled: true, notApplicable: true },
    ]);
    const written = template.replace('在这里写依据', '近 30 天日志');
    expect(briefSectionFolds(written, template)[1]).toMatchObject({ unfilled: false, notApplicable: false });
  });

  it('不涉及同样认，编辑器重排的标题仍对得上', () => {
    const md = '## 1\\. 问题与目标\n\n不涉及：历史数据不改\n';
    expect(briefSectionFolds(md, template)[0]).toMatchObject({ key: '问题与目标', unfilled: false, notApplicable: true });
  });
});
