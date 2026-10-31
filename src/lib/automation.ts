export const AUTOMATION_KEYS = [
  "recurringSend",
  "reminders",
  "paymentReceipt",
  "advanceInvoice",
] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

// Payment receipts and sending after an advance payment arrive in later plans: visible, not switchable.
export const AUTOMATIONS: readonly { key: AutomationKey; available: boolean }[] = [
  { key: "recurringSend", available: true },
  { key: "reminders", available: true },
  { key: "paymentReceipt", available: false },
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
  "recurring_failed",
  "recurring_missed",
  "recurring_held",
  "recurring_no_address",
  "recurring_bad_mail",
  "recurring_upcoming",
  "reminder_failed",
  "reminder_missed",
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
