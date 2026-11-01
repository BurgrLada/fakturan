import "server-only";
import { deviationExceeds, rateDate } from "@/lib/fx";
import type { NotificationParams } from "@/lib/automation";
import type { CalendarDate } from "@/lib/number-format";
import { formatCalendarDate } from "@/lib/template-vars";
import { clock } from "../clock";
import type { Tx } from "../db";
import { resolveRate } from "./exchange-rates";
import { findOwned, type Invoice } from "./invoices";
import { notify } from "./notifications";
import { getPreferences } from "./preferences";

function displayDate(ownerId: string, date: CalendarDate): string {
  return formatCalendarDate(date, getPreferences(ownerId).dateFormat);
}

function fixedDeviates(tx: Tx, userId: string, issued: Invoice): boolean {
  const day = rateDate(issued, getPreferences(userId).fxBasis, issued.issueDate!);
  const reference = resolveRate(tx, userId, issued.currency, day, clock.now())?.reference;
  return reference != null && deviationExceeds(issued.exchangeRateMicros!, reference);
}

// A document issued without anyone looking: whoever would have seen the rate in the dialog hears
// about it here. `origin` names the document in the text, a plan or a number.
export function noticeIssuedRate(
  tx: Tx,
  userId: string,
  invoiceId: string,
  key: string,
  origin: NotificationParams,
): void {
  const issued = findOwned(tx, userId, invoiceId);
  const params = {
    ...origin,
    currency: issued.currency,
    date: displayDate(userId, issued.issueDate!),
  };
  const dedupeKey = `${key}:rate`;
  const entity = { type: "invoice", id: invoiceId };
  if (issued.exchangeRateSource === "fixed") {
    if (fixedDeviates(tx, userId, issued)) {
      notify(tx, { userId, kind: "rate_deviation", dedupeKey, params, entity });
    }
    return;
  }
  if (issued.exchangeRateSource !== "last_known") return;
  notify(tx, {
    userId,
    kind: "rate_last_known",
    dedupeKey,
    params: { ...params, listDate: displayDate(userId, issued.exchangeRateDate!) },
    entity,
  });
}
