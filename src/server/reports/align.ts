import type { Series } from "./types";

// The previous period can have one bucket more or less than the current one (a custom range of
// equal days crosses another number of month ends). Buckets pair from the end, and any surplus
// previous buckets fold into the first row, so the column still adds up to the previous summary.
export function alignPrevious(current: Series, previous: Series): number[] {
  const values = previous.points.map((point) => point.amountMinor);
  const surplus = values.length - current.points.length;
  if (surplus > 0 && current.points.length > 0) {
    const head = values.slice(0, surplus + 1).reduce((sum, value) => sum + value, 0);
    return [head, ...values.slice(surplus + 1)];
  }
  return current.points.map((_, index) => values[index + surplus] ?? 0);
}
