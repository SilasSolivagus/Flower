const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function stateLabel(states: Array<{ key: string; label: string }>, key: string | null): string {
  if (key === null) return '（创建）';
  return states.find((s) => s.key === key)?.label ?? key;
}
