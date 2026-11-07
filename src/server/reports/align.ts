import type { CalendarDate } from "@/lib/number-format";
import {
  bucketsBetween,
  isRunningPeriod,
  type BucketUnit,
  type DateRange,
} from "@/lib/report-period";
import type { Series } from "./types";

export type AlignAnchor = "start" | "end";

// The previous period can have one bucket more or less than the current one (a custom range of
// equal days crosses another number of month ends). From the end, surplus previous buckets fold
// into the first row; from the start (a running period compared up to the same day) into the last.
// Either way the column still adds up to the previous summary.
export function alignPrevious(
  current: Series,
  previous: Series,
  anchor: AlignAnchor = "end",
): number[] {
  const values = previous.points.map((point) => point.amountMinor);
  const length = current.points.length;
  const surplus = values.length - length;
  if (anchor === "start") {
    const paired = current.points.map((_, index) => values[index] ?? 0);
    if (surplus > 0 && length > 0) {
      paired[length - 1] = values.slice(length - 1).reduce((sum, value) => sum + value, 0);
    }
    return paired;
  }
  if (surplus > 0 && length > 0) {
    const head = values.slice(0, surplus + 1).reduce((sum, value) => sum + value, 0);
    return [head, ...values.slice(surplus + 1)];
  }
  return current.points.map((_, index) => values[index + surplus] ?? 0);
}

// R-11 of plan 9: a running period pairs day with day from the start, a finished one from the end.
export function anchorFor(range: DateRange, today: CalendarDate): AlignAnchor {
  return isRunningPeriod(range, today) ? "start" : "end";
}

// A previous period cut short at today's date gets the buckets of the whole period back as zeros,
// so a running period's buckets line up with those of the whole previous one.
export function spanSeries(series: Series, span: DateRange, unit: BucketUnit): Series {
  const values = new Map(series.points.map((point) => [point.key, point.amountMinor]));
  return {
    ...series,
    points: bucketsBetween(span, unit).map((key) => ({ key, amountMinor: values.get(key) ?? 0 })),
  };
}
