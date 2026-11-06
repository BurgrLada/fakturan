// Rows one account may hold in its configuration tables. Each is read whole somewhere (a card, a
// form, a settings page, the hourly planning), so the count is capped as well as the row size
// (C-2 of plan 9). The values sit far above any real use; a restore refuses an archive over them
// and the app refuses the row that would cross them. Reminder rules and widgets keep the app's own
// tighter caps (MAX_REMINDER_RULES, MAX_WIDGETS on each of the dashboards).
export const ACCOUNT_ROW_LIMITS = {
  reminder_rule: 200,
  invoice_template: 500,
  recurring_invoice: 500,
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

export function accountRowLimit(table: string): number | undefined {
  return Object.hasOwn(ACCOUNT_ROW_LIMITS, table)
    ? ACCOUNT_ROW_LIMITS[table as LimitedTable]
    : undefined;
}
