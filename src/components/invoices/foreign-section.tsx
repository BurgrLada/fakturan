"use client";

import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { CURRENCIES, type Currency } from "@/lib/currency";
import type { ExchangeRateSource } from "@/lib/fx";
import { foreignFieldsOpen, type FormValues } from "@/lib/invoice-form";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.foreign;

function sourceLabel(source: ExchangeRateSource, date: string | null): string {
  if (source === "cnb") return date ? T.sources.cnb(date) : T.sources.cnbNoDate;
  if (source === "last_known")
    return date ? T.sources.last_known(date) : T.sources.last_knownNoDate;
  return T.sources[source];
}

export function RateField({
  values,
  listDate,
  notes,
  invalid,
  locked,
  lockedNote,
  useAutomaticLabel,
  onChange,
  onUseAutomatic,
}: {
  values: Pick<FormValues, "exchangeRate" | "exchangeRateSource">;
  listDate: string | null;
  notes: string[];
  invalid: boolean;
  locked: boolean;
  lockedNote: string;
  useAutomaticLabel: string | null;
  onChange: (text: string) => void;
  onUseAutomatic: () => void;
}) {
  const { exchangeRateSource: source } = values;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor="field-exchangeRate">{T.rate}</Label>
      <Input
        id="field-exchangeRate"
        inputMode="decimal"
        disabled={locked}
        aria-describedby={locked ? "field-rate-locked" : undefined}
        aria-invalid={invalid || undefined}
        value={values.exchangeRate}
        onChange={(event) => onChange(event.target.value)}
      />
      {source && values.exchangeRate && (
        <p data-testid="rate-source" className="text-xs text-muted-foreground">
          {sourceLabel(source, listDate)}
        </p>
      )}
      {locked && (
        <p id="field-rate-locked" className="text-xs text-muted-foreground">
          {lockedNote}
        </p>
      )}
      {useAutomaticLabel && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onUseAutomatic}>
            {useAutomaticLabel}
          </Button>
        </div>
      )}
      {notes.length > 0 && (
        <Alert role="status" data-testid="rate-notes">
          <AlertDescription className="flex flex-col gap-1">
            {notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function ForeignSection({
  values,
  currencyLocked = false,
  currencyNote = "",
  onForeign,
  onCurrency,
  onClause,
  children,
}: {
  values: Pick<FormValues, "foreign" | "currency" | "clause">;
  currencyLocked?: boolean;
  currencyNote?: string;
  onForeign: (on: boolean) => void;
  onCurrency: (currency: Currency) => void;
  onClause: (text: string) => void;
  children?: ReactNode;
}) {
  const open = foreignFieldsOpen(values);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          id="field-foreign"
          type="checkbox"
          className="size-4 accent-primary"
          checked={values.foreign}
          onChange={(event) => onForeign(event.target.checked)}
        />
        <Label htmlFor="field-foreign">{T.toggle}</Label>
      </div>
      {open && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor="field-currency">{T.currency}</Label>
              <NativeSelect
                id="field-currency"
                disabled={currencyLocked}
                aria-describedby={currencyLocked ? "field-currency-locked" : undefined}
                value={values.currency}
                onChange={(event) => onCurrency(event.target.value as Currency)}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </NativeSelect>
              {currencyLocked && (
                <p id="field-currency-locked" className="text-xs text-muted-foreground">
                  {currencyNote}
                </p>
              )}
            </div>
            {children}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="field-clause">{T.clause}</Label>
            <Textarea
              id="field-clause"
              aria-describedby="field-clause-hint"
              value={values.clause}
              onChange={(event) => onClause(event.target.value)}
            />
            <p id="field-clause-hint" className="text-xs text-muted-foreground">
              {T.clauseHint}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
