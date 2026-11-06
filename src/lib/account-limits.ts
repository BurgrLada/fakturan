import { MAX_WIDGETS } from "./dashboard-layout";
import { MAX_DOCUMENT_LINES } from "./invoice";
import { MAX_REMINDER_RULES } from "./reminders";

// Rows one account may hold in its configuration tables. Each is read whole somewhere (a card, a
// form, a settings page, the hourly planning), so the count is capped as well as the row size
// (C-2 of plan 9). The values sit far above any real use; a restore refuses an archive over them
// and the app refuses the row that would cross them. Reminder rules are the app's own cap.
export const ACCOUNT_ROW_LIMITS = {
  reminder_rule: MAX_REMINDER_RULES,
  invoice_template: 2_000,
  recurring_invoice: 2_000,
  dashboard: 50,
  dashboard_widget: 2_500,
  mapping_preset: 200,
  unit: 500,
  number_series: 200,
  bank_account: 100,
  tag: 2_000,
  email_template: 100,
} as const;

export type LimitedTable = keyof typeof ACCOUNT_ROW_LIMITS;

// Rows that belong to one parent row: the lines of a document (the form and the import allow 500)
// and the widgets of a dashboard (MAX_WIDGETS). A restore checks them per parent.
export const PER_PARENT_LIMITS: Record<string, { parent: string; limit: number }> = {
  invoice_line: { parent: "invoice_id", limit: MAX_DOCUMENT_LINES },
  dashboard_widget: { parent: "dashboard_id", limit: MAX_WIDGETS },
};

export function accountRowLimit(table: string): number | undefined {
  return Object.hasOwn(ACCOUNT_ROW_LIMITS, table)
    ? ACCOUNT_ROW_LIMITS[table as LimitedTable]
    : undefined;
}
