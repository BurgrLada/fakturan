import "server-only";
import type { InvoiceFormProps } from "@/components/invoices/invoice-form";
import { listBankAccounts } from "@/server/services/bank-accounts";
import { listUnits } from "@/server/services/catalog";
import { listSeries } from "@/server/services/number-series";
import { getPreferences } from "@/server/services/preferences";
import { listTags } from "@/server/services/tags";

type Choices = Pick<
  InvoiceFormProps,
  "accounts" | "series" | "units" | "tagOptions" | "defaultUnit"
>;

export function formChoices(ownerId: string, keptAccountId: string | null): Choices {
  return {
    accounts: listBankAccounts(ownerId)
      .filter((account) => !account.hidden || account.id === keptAccountId)
      .map(({ id, name, currency, isDefault }) => ({ id, name, currency, isDefault })),
    series: listSeries(ownerId)
      .filter((row) => row.documentType === "invoice")
      .map(({ id, name }) => ({ id, name })),
    units: listUnits(ownerId).map((unit) => unit.name),
    tagOptions: listTags(ownerId).map((tag) => tag.name),
    defaultUnit: getPreferences(ownerId).unit,
  };
}
