import "server-only";
import type { Alert } from "@/lib/automation";
import { noticeCounts } from "./bank-notices";
import { registerDerivedAlerts } from "./notifications";

// Computed on every read like the due alerts, so settling the last notice makes the alert vanish.
function alertsFor(ownerId: string, today: string): Alert[] {
  const { pending, unrecognized } = noticeCounts(ownerId);
  const alerts: Alert[] = [];
  if (pending > 0) {
    alerts.push({
      dedupeKey: `notices:pending:${today}`,
      kind: "payments_unmatched",
      params: { count: pending },
    });
  }
  if (unrecognized > 0) {
    alerts.push({
      dedupeKey: `notices:unrecognized:${today}`,
      kind: "notices_unrecognized",
      params: { count: unrecognized },
    });
  }
  return alerts;
}

registerDerivedAlerts(alertsFor);
