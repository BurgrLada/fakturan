export type FieldChange = { field: string; before: string; after: string };

function show(value: unknown): string {
  if (value === undefined) return "–";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diffAudit(before: unknown, after: unknown): FieldChange[] {
  const left = isRecord(before) ? before : {};
  const right = isRecord(after) ? after : {};
  if (!isRecord(before) && before != null)
    return [{ field: "–", before: show(before), after: show(after) }];
  if (!isRecord(after) && after != null)
    return [{ field: "–", before: show(before), after: show(after) }];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((field) => ({ field, before: show(left[field]), after: show(right[field]) }));
}
