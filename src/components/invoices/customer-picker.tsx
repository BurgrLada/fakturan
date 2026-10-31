"use client";

import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import { createCustomerAction, searchCustomersAction } from "@/app/(app)/faktury/actions";
import { EMPTY_CUSTOMER, toPayload } from "@/components/customers/customer-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TEXTS } from "@/lib/texts";
import { Combobox } from "./combobox";

const T = TEXTS.invoices.form;
const C = TEXTS.customers.fields;

type Option = { id: string; name: string; ico: string; city: string };
type PanelField = "name" | "ico" | "street" | "city" | "zip" | "email";

const PANEL_FIELDS: PanelField[] = ["name", "ico", "street", "city", "zip", "email"];

export function CustomerPicker({
  name,
  invalid,
  onNameChange,
  onPick,
  onExpired,
}: {
  name: string;
  invalid?: boolean;
  onNameChange: (name: string) => void;
  onPick: (customer: { id: string; name: string }) => void;
  onExpired: () => void;
}) {
  const [panel, setPanel] = useState<Record<PanelField, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const creating = useRef(false);

  async function search(q: string): Promise<Option[]> {
    const result = await searchCustomersAction({ q });
    if (result.ok) return result.customers;
    if (result.expired) onExpired();
    return [];
  }

  function openPanel(query: string) {
    setError(null);
    setPanel({ name: query, ico: "", street: "", city: "", zip: "", email: "" });
  }

  function create() {
    if (!panel || creating.current) return;
    creating.current = true;
    startTransition(async () => {
      try {
        const result = await createCustomerAction(toPayload({ ...EMPTY_CUSTOMER, ...panel }));
        if (!result.ok) {
          if (result.expired) onExpired();
          else setError(result.error);
          return;
        }
        onPick({ id: result.id, name: panel.name.trim() });
        setPanel(null);
      } catch {
        setError(T.network);
      } finally {
        creating.current = false;
      }
    });
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      create();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setPanel(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="field-customerId">{T.fields.customer}</Label>
      <Combobox
        id="field-customerId"
        value={name}
        invalid={invalid}
        onValueChange={onNameChange}
        search={search}
        optionKey={(option: Option) => option.id}
        renderOption={(option) => (
          <>
            {option.name}
            <span className="ml-2 text-muted-foreground">
              {[option.ico, option.city].filter(Boolean).join(", ")}
            </span>
          </>
        )}
        onSelect={onPick}
        extra={{ label: T.customerNew, onSelect: openPanel }}
      />
      {panel && (
        <div
          role="group"
          aria-label={T.customerPanel}
          className="flex flex-col gap-3 rounded-md border p-3"
          onKeyDown={onPanelKeyDown}
        >
          <h3 className="text-sm font-medium">{T.customerPanel}</h3>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {PANEL_FIELDS.map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <Label htmlFor={`new-customer-${field}`}>{C[field]}</Label>
                <Input
                  id={`new-customer-${field}`}
                  autoFocus={field === "name"}
                  value={panel[field]}
                  onChange={(event) => setPanel({ ...panel, [field]: event.target.value })}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" disabled={pending} onClick={create}>
              {T.customerSave}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
              {T.customerCancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
