/** Validate freshly proposed planner titles; legacy persisted Plans are not re-parsed. */
export function requiredPlannerTaskTitle(value: unknown, index: number): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Planner next_tasks[${index}].title is required`);
  const title = value.trim();
  const words = title.split(/\s+/);
  if (words.length < 5 || words.length > 8)
    throw new Error(`Planner next_tasks[${index}].title must contain 5–8 words (got ${words.length})`);
  return title;
}
