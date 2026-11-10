import type { NotificationKind, NotificationParams } from "./automation";
import { TEXTS } from "./texts";

const T = TEXTS.notifications;

// A stored row can outlive its kind: the column is not checked on read, and a rollback leaves newer rows.
export function notificationText(kind: NotificationKind, params: NotificationParams): string {
  return T.kinds[kind]?.(params) ?? T.unknownKind;
}

export type NotificationTarget = { href: string; label: string };

const ENTITY_TARGETS: Record<string, (id: string) => NotificationTarget> = {
  invoice: (id) => ({ href: `/faktury/${id}`, label: T.open.invoice }),
  recurring_invoice: (id) => ({ href: `/pravidelne/${id}`, label: T.open.plan }),
};

// Derived alerts and settings-level events have no entity, so their kind alone names the place.
const KIND_TARGETS: Partial<Record<NotificationKind, NotificationTarget>> = {
  invoices_overdue: { href: "/faktury?stav=po-splatnosti", label: T.open.overdue },
  invoices_due_soon: { href: "/faktury?razeni=splatnost&smer=asc", label: T.open.dueSoon },
  reminder_missed: { href: "/nastaveni/automatizace#reminder-review", label: T.open.reminders },
  payments_unmatched: { href: "/platby#queue-title", label: T.open.payments },
  notices_unrecognized: { href: "/platby#unrecognized-title", label: T.open.payments },
  notices_over_limit: { href: "/platby#unrecognized-title", label: T.open.payments },
  bank_connection_failed: { href: "/nastaveni/aviza", label: T.open.mailbox },
  turnover_limit: { href: "/prehledy?zalozka=limity", label: T.open.limits },
  export_ready: { href: "/nastaveni/export", label: T.open.exports },
  backup_ready: { href: "/nastaveni/zaloha", label: T.open.backups },
  backup_restored: { href: "/nastaveni/zaloha", label: T.open.backups },
};

export function notificationTarget(
  kind: NotificationKind,
  entity: { type: string | null; id: string | null } = { type: null, id: null },
): NotificationTarget | null {
  const byEntity = entity.type && entity.id ? ENTITY_TARGETS[entity.type]?.(entity.id) : undefined;
  return byEntity ?? KIND_TARGETS[kind] ?? null;
}
