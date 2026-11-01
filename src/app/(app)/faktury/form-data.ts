import "server-only";
import type { InvoiceFormProps } from "@/components/invoices/invoice-form";
import type { InvoiceType } from "@/lib/invoice";
import { listBankAccounts } from "@/server/services/bank-accounts";
import { listUnits } from "@/server/services/catalog";
import { normalizeIban } from "@/lib/iban";
import { calendarDateInPrague } from "@/lib/number-format";
import { clock } from "@/server/clock";
import { listSeries } from "@/server/services/number-series";
import { getPreferences } from "@/server/services/preferences";
import { clauseDefaultsOf } from "@/server/services/supplier";
import { listTags } from "@/server/services/tags";

type Choices = Pick<
  InvoiceFormProps,
  | "accounts"
  | "series"
  | "units"
  | "tagOptions"
  | "defaultUnit"
  | "fxBasis"
  | "dateFormat"
  | "today"
  | "homeCurrency"
  | "clauseDefaults"
>;

export function formChoices(
  ownerId: string,
  keptAccountId: string | null,
  type: InvoiceType,
): Choices {
  const prefs = getPreferences(ownerId);
  return {
    accounts: listBankAccounts(ownerId)
      .filter((account) => !account.hidden || account.id === keptAccountId)
      .map(({ id, name, currency, isDefault, iban, swift }) => ({
        id,
        name,
        currency,
        isDefault,
        iban: Boolean(iban.trim()),
        czechIban: normalizeIban(iban).startsWith("CZ"),
        bic: Boolean(swift.trim()),
      })),
    series: listSeries(ownerId)
      .filter((row) => row.documentType === type)
      .map(({ id, name }) => ({ id, name })),
    units: listUnits(ownerId).map((unit) => unit.name),
    tagOptions: listTags(ownerId).map((tag) => tag.name),
    defaultUnit: prefs.unit,
    fxBasis: prefs.fxBasis,
    dateFormat: prefs.dateFormat,
    today: calendarDateInPrague(clock.now()),
    homeCurrency: prefs.currency,
    clauseDefaults: clauseDefaultsOf(ownerId),
  };
}
