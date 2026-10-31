import type { NotificationKind, NotificationParams } from "./automation";
import { TEXTS } from "./texts";

const T = TEXTS.notifications;

// A stored row can outlive its kind: the column is not checked on read, and a rollback leaves newer rows.
export function notificationText(kind: NotificationKind, params: NotificationParams): string {
  return T.kinds[kind]?.(params) ?? T.unknownKind;
}
