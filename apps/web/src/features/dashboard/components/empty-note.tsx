/** 区块没有数据时的说明，原因以可见文字给出。 */
export function EmptyNote({ text }: { text: string }) {
  return <p className="rounded-md border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">{text}</p>;
}
