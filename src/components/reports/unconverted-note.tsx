import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import type { Unconverted } from "@/server/reports/types";

// R-9: a number that misses records without a rate says so, with their amount in its own currency.
export function UnconvertedNote({
  unconverted,
  prefix,
  testId = "unconverted",
}: {
  unconverted: Unconverted;
  prefix?: string;
  testId?: string;
}) {
  if (unconverted.count === 0) return null;
  return (
    <p data-testid={testId} className="text-xs text-muted-foreground">
      {prefix && `${prefix}: `}
      {TEXTS.reports.unconverted(unconverted.count)}:{" "}
      {unconverted.byCurrency
        .map(({ currency, amountMinor }) => formatMoney(amountMinor, currency))
        .join(", ")}
    </p>
  );
}
