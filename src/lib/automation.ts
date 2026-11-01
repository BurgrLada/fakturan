export const AUTOMATION_KEYS = [
  "recurringSend",
  "reminders",
  "paymentReceipt",
  "advanceInvoice",
] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

// Sending after an advance payment arrives in a later plan: visible, not switchable.
export const AUTOMATIONS: readonly { key: AutomationKey; available: boolean }[] = [
  { key: "recurringSend", available: true },
  { key: "reminders", available: true },
  { key: "paymentReceipt", available: true },
  { key: "advanceInvoice", available: false },
];

export const DEFAULT_SEND_TIME = "09:00";

export const SEND_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type AutomationSettings = Record<AutomationKey, boolean> & {
  paused: boolean;
  remindersOpenSince: string | null;
  sendTime: string;
  dailyDigest: boolean;
};

export const DEFAULT_AUTOMATION: AutomationSettings = {
  recurringSend: false,
  reminders: false,
  paymentReceipt: false,
  advanceInvoice: false,
  paused: false,
  remindersOpenSince: null,
  sendTime: DEFAULT_SEND_TIME,
  dailyDigest: false,
};

export const NOTIFICATION_KINDS = [
  "mail_failed",
  "mail_unknown",
  "mail_held",
  "mail_partial",
  "mail_stale",
  "recurring_failed",
  "recurring_missed",
  "recurring_held",
  "recurring_no_address",
  "recurring_bad_mail",
  "recurring_upcoming",
  "recurring_conflict",
  "reminder_failed",
  "reminder_missed",
  "invoices_overdue",
  "invoices_due_soon",
  "bank_connection_failed",
  "payments_unmatched",
  "notices_unrecognized",
  "receipt_no_address",
  "receipt_bad_mail",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationParams = Record<string, string | number | boolean | null>;

export type NotificationEntity = { type: string; id: string };

export type Alert = {
  dedupeKey: string;
  kind: NotificationKind;
  params: NotificationParams;
  entity?: NotificationEntity;
};
