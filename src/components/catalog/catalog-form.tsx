"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { saveCatalogItemAction } from "@/app/(app)/cenik/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { parseMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.catalog;

export type CatalogValues = {
  id?: string;
  name: string;
  description: string;
  unit: string;
  price: string;
  currency: Currency;
  category: string;
  tags: string;
};

export function CatalogForm({
  initial,
  units,
  defaultCurrency,
}: {
  initial: CatalogValues | null;
  units: string[];
  defaultCurrency: Currency;
}) {
  const router = useRouter();
  const [values, setValues] = useState<CatalogValues>(
    initial ?? {
      name: "",
      description: "",
      unit: units[0] ?? "",
      price: "",
      currency: defaultCurrency,
      category: "",
      tags: "",
    },
  );
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const options = units.includes(values.unit) ? units : [values.unit, ...units];

  const change = <K extends keyof CatalogValues>(name: K, value: CatalogValues[K]) =>
    setValues((current) => ({ ...current, [name]: value }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const priceMinor = parseMoney(values.price);
    if (priceMinor === null) {
      setMessage({ ok: false, text: T.validation.price });
      return;
    }
    startTransition(async () => {
      const { price: _price, tags, ...rest } = values;
      const result = await saveCatalogItemAction({
        ...rest,
        priceMinor,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      if (!values.id) {
        router.push(`/cenik/${result.id}`);
        return;
      }
      setMessage({ ok: true, text: T.saved });
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 sm:max-w-xl">
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="item-name">{T.fields.name}</Label>
        <Input
          id="item-name"
          value={values.name}
          required
          onChange={(event) => change("name", event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="item-description">{T.fields.description}</Label>
        <Input
          id="item-description"
          value={values.description}
          onChange={(event) => change("description", event.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="item-price">{T.fields.price}</Label>
          <Input
            id="item-price"
            inputMode="decimal"
            value={values.price}
            required
            aria-describedby="item-price-hint"
            onChange={(event) => change("price", event.target.value)}
          />
          <p id="item-price-hint" className="text-xs text-muted-foreground">
            {T.priceHint}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="item-currency">{T.fields.currency}</Label>
          <NativeSelect
            id="item-currency"
            value={values.currency}
            onChange={(event) => change("currency", event.target.value as Currency)}
          >
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="item-unit">{T.fields.unit}</Label>
          <NativeSelect
            id="item-unit"
            value={values.unit}
            onChange={(event) => change("unit", event.target.value)}
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="item-category">{T.fields.category}</Label>
        <Input
          id="item-category"
          value={values.category}
          onChange={(event) => change("category", event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="item-tags">{T.fields.tags}</Label>
        <Input
          id="item-tags"
          value={values.tags}
          aria-describedby="item-tags-hint"
          onChange={(event) => change("tags", event.target.value)}
        />
        <p id="item-tags-hint" className="text-xs text-muted-foreground">
          {T.tagsHint}
        </p>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {T.save}
        </Button>
      </div>
    </form>
  );
}
