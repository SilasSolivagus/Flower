/** 「被引用」每一条的来源说明：需求描述 / PRD 的小节 / 评论。 */
export function backlinkViaLabel(item: { via: 'description' | 'body' | 'comment'; section: string | null }): string {
  if (item.via === 'description') return '需求描述';
  if (item.via === 'comment') return '评论';
  return item.section ? `小节「${item.section}」` : '正文';
}
