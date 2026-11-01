"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CURRENCIES } from "@/lib/currency";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.preferences.fixedRates;

export const FOREIGN_CURRENCIES = CURRENCIES.filter((currency) => currency !== "CZK");

export function FixedRates({
  rates,
  onChange,
}: {
  rates: Record<string, string>;
  onChange: (currency: string, text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{T.title}</h3>
      <p className="text-sm text-muted-foreground">{T.hint}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FOREIGN_CURRENCIES.map((currency) => (
          <div key={currency} className="flex flex-col gap-2">
            <Label htmlFor={`pref-fixed-${currency}`}>{T.rate(currency)}</Label>
            <Input
              id={`pref-fixed-${currency}`}
              inputMode="decimal"
              value={rates[currency] ?? ""}
              onChange={(event) => onChange(currency, event.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
