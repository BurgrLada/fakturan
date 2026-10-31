import Link from "next/link";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES } from "@/lib/currency";
import { INVOICE_TYPES } from "@/lib/invoice";
import { TEXTS } from "@/lib/texts";
import {
  INVOICE_STATUS_PARAM,
  INVOICE_STATUS_FILTERS,
  invoiceSortParams,
  type InvoiceFilter,
  type InvoiceFilterOptions,
} from "@/server/services/invoices";

const T = TEXTS.invoices.list;

// Controls sit inside their label: a route hidden by Next keeps its ids in the DOM, and the same
// list with another query is a separate hidden route.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="flex-col items-stretch gap-1">
      {label}
      {children}
    </Label>
  );
}

export function InvoiceFilters({
  filter,
  options,
}: {
  filter: InvoiceFilter;
  options: InvoiceFilterOptions;
}) {
  return (
    <form
      method="get"
      action="/faktury"
      aria-label={T.filters}
      className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      {Object.entries(invoiceSortParams(filter)).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Field label={T.search}>
        <Input
          name="q"
          type="search"
          defaultValue={filter.q ?? ""}
          placeholder={T.searchPlaceholder}
        />
      </Field>
      <Field label={T.status}>
        <NativeSelect
          name="stav"
          defaultValue={filter.status ? INVOICE_STATUS_PARAM[filter.status] : ""}
        >
          <option value="">{T.all}</option>
          {INVOICE_STATUS_FILTERS.map((status) => (
            <option key={status} value={INVOICE_STATUS_PARAM[status]}>
              {TEXTS.invoices.statuses[status]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={T.customer}>
        <NativeSelect name="zakaznik" defaultValue={filter.customerId ?? ""}>
          <option value="">{T.all}</option>
          {options.customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={T.from}>
        <Input name="od" type="date" defaultValue={filter.from ?? ""} />
      </Field>
      <Field label={T.to}>
        <Input name="do" type="date" defaultValue={filter.to ?? ""} />
      </Field>
      <Field label={T.currency}>
        <NativeSelect name="mena" defaultValue={filter.currency ?? ""}>
          <option value="">{T.all}</option>
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={T.type}>
        <NativeSelect name="typ" defaultValue={filter.type ?? ""}>
          <option value="">{T.all}</option>
          {INVOICE_TYPES.map((type) => (
            <option key={type} value={type}>
              {T.types[type]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {options.tags.length > 0 && (
        <Field label={T.tag}>
          <NativeSelect name="stitek" defaultValue={filter.tagId ?? ""}>
            <option value="">{T.all}</option>
            {options.tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <label className="flex items-center gap-2 text-sm sm:pb-2">
        <input type="checkbox" name="jinde" value="1" defaultChecked={filter.external ?? false} />
        {T.external}
      </label>
      <div className="flex gap-2">
        <Button type="submit">{T.apply}</Button>
        <Link href="/faktury" className={buttonVariants({ variant: "outline" })}>
          {T.reset}
        </Link>
      </div>
    </form>
  );
}
