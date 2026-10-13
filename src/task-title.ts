export function deriveTaskTitle(input: string, fallback = 'Task'): string {
  const first = String(input ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? fallback;
  const cleaned = first.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/\s+/g, ' ').trim() || fallback;
  return cleaned.length <= 96 ? cleaned : cleaned.slice(0, 93).trimEnd() + '...';
}
