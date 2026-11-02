import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import type { Unconverted } from "@/server/reports/types";

// R-9: a number that misses records without a rate says so, with their amount in its own currency.
export function UnconvertedNote({ unconverted }: { unconverted: Unconverted }) {
  if (unconverted.count === 0) return null;
  return (
    <p data-testid="unconverted" className="text-xs text-muted-foreground">
      {TEXTS.reports.unconverted(unconverted.count)}:{" "}
      {unconverted.byCurrency
        .map(({ currency, amountMinor }) => formatMoney(amountMinor, currency))
        .join(", ")}
    </p>
  );
}
