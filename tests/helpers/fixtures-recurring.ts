import type { TemplateDocument } from "@/lib/invoice-template";
import { appearanceFrom } from "@/lib/invoice";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { saveRecurring, type RecurringInput } from "@/server/services/recurring";
import { webActor } from "./fixtures-mail";

export function planDocument(over: Partial<TemplateDocument> = {}): TemplateDocument {
  return {
    type: "invoice",
    bankAccountId: null,
    dueDays: 14,
    language: "cs",
    currency: "CZK",
    paymentMethod: "transfer",
    orderRef: "",
    reference: "",
    textBefore: "Fakturujeme {{mesic_nazev}} {{rok}}",
    textAfter: "",
    note: "",
    discountKind: "none",
    discountValue: 0,
    rounding: "none",
    appearance: appearanceFrom(DEFAULT_PREFERENCES),
    lines: [
      {
        catalogItemId: null,
        name: "Správa za {{mesic}}/{{rok}}",
        description: "",
        quantityMilli: 1000,
        unit: "ks",
        unitPriceMinor: 100_000,
        discountKind: "none",
        discountValue: 0,
      },
    ],
    ...over,
  };
}

export function planInput(customerId: string | null, over: Partial<RecurringInput> = {}) {
  return {
    name: "Správa webu",
    customerId,
    document: planDocument(),
    frequency: "monthly",
    every: 1,
    issueRule: "day",
    issueDay: 10,
    startsOn: "2026-03-01",
    endsOn: null,
    maxCount: null,
    periodOffset: 0,
    ...over,
  } satisfies RecurringInput;
}

export function savePlan(
  owner: string,
  customerId: string | null,
  over: Partial<RecurringInput> = {},
): string {
  return saveRecurring(webActor(owner), planInput(customerId, over)).id;
}
