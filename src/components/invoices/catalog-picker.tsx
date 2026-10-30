"use client";

import { searchCatalogAction } from "@/app/(app)/faktury/actions";
import type { Currency } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import { Combobox } from "./combobox";

export type CatalogChoice = {
  id: string;
  name: string;
  description: string;
  unit: string;
  priceMinor: number;
  currency: Currency;
};

async function search(q: string): Promise<CatalogChoice[]> {
  const result = await searchCatalogAction({ q });
  return result.ok ? result.items : [];
}

export function CatalogPicker({
  id,
  value,
  invalid,
  onChange,
  onPick,
}: {
  id: string;
  value: string;
  invalid?: boolean;
  onChange: (value: string) => void;
  onPick: (item: CatalogChoice) => void;
}) {
  return (
    <Combobox
      id={id}
      value={value}
      invalid={invalid}
      onValueChange={onChange}
      search={search}
      optionKey={(item: CatalogChoice) => item.id}
      renderOption={(item) => (
        <>
          {item.name}
          <span className="ml-2 text-muted-foreground">
            {formatMoney(item.priceMinor, item.currency)} / {item.unit}
          </span>
        </>
      )}
      onSelect={onPick}
    />
  );
}
