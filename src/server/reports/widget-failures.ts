import "server-only";
import { reportFailure } from "../scheduler/report";

// A broken widget renders on every visit; one report per widget and failure is enough to act on,
// the rest would only bury other errors.
const reported = new Set<string>();
const MAX_KEYS = 10_000;

export function reportWidgetFailure(
  widgetId: string,
  task: string,
  error: unknown,
  userId: string,
): void {
  const key = `${task}:${widgetId}`;
  if (reported.has(key)) return;
  if (reported.size >= MAX_KEYS) reported.clear();
  reported.add(key);
  reportFailure(error, { task, userId });
}
