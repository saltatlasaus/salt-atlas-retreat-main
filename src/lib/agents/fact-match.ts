/** Accept the checklist id, or the short key the model sometimes returns. */
export function matchFactId(raw: string, ids: string[]): string | undefined {
  const id = raw.trim();
  if (ids.includes(id)) return id;
  return ids.find((candidate) => candidate.endsWith(`-${id}`) || candidate.endsWith(`_${id}`));
}
