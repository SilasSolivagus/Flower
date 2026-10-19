-- 预置简报模板文案与代码常量对齐（P3-C2 UX）。只改名为「需求简报（预置）」且正文、小节或说明里仍有「闸口」的行；
-- 说明若已被改过、与初版逐字不同，则保留。可重复执行。
UPDATE document_templates
SET
  body = replace(
    replace(
      replace(body,
        '## 17. 写 PRD 闸口', '## 17. 写 PRD 前检查'),
      '| 4 | 第 5 节对象与状态已确认（或注明不适用） | |', '| 4 | 第 5 节对象与状态已确认（或注明不涉及） | |'),
    '| 11 | 决策人确认过第 1、6、7、13 节 | |', '| 11 | 确认人确认过第 1、6、7、13 节 | |'),
  sections = replace(
    replace(
      replace(
        replace(sections::text,
          '不涉及写「不适用：理由」', '不涉及时写「不涉及：理由」（也可写「不适用：理由」）'),
        '17. 写 PRD 闸口', '17. 写 PRD 前检查'),
      '闸口结果以侧栏「写 PRD 闸口」为准', '检查结果以侧栏「写 PRD 前检查」为准'),
    '转 PRD 时按此表拼接', '生成 PRD 时按此表拼接')::jsonb,
  guidance = CASE
    WHEN guidance = $old$- 简报记录的是讨论到当前为止的结论，不是会议流水账。结论被推翻时直接改正文，推翻的过程记进第 15 节「决策日志」。
- 每一节都必须填写；不涉及的写「不适用：理由」，不能空着。
- 第 17 节的闸口全部通过后才能开始写 PRD。PRD 的各章节从对应小节取内容（见第 18 节）。$old$
    THEN $new$- 简报记录的是讨论到当前为止的结论，不是会议流水账。结论被推翻时直接改正文，推翻的过程记进第 15 节「决策日志」。
- 每节都要有内容。不涉及就写：不涉及：……理由（写「不适用：理由」也同样认）。
- 写 PRD 前尽量勾完检查项；未勾完也能生成，系统会列出还差的项。$new$
    ELSE guidance
  END,
  updated_at = now()
WHERE kind = 'brief'
  AND name = '需求简报（预置）'
  AND (
    body LIKE '%写 PRD 闸口%'
    OR sections::text LIKE '%写 PRD 闸口%'
    OR guidance LIKE '%闸口%'
  );
