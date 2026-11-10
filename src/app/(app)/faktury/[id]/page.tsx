import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { EntityHistory } from "@/components/audit/entity-history";
import { EmailHistory } from "@/components/invoices/email-history";
import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { ImportedActions } from "@/components/invoices/imported-actions";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status";
import { ReminderPanel } from "@/components/invoices/reminder-panel";
import { VersionList } from "@/components/invoices/version-list";
import { PaymentPanel } from "@/components/invoices/payment-panel";
import { RelatedDocuments } from "@/components/invoices/related-documents";
import { PageLoading } from "@/components/page-loading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { GoToLink } from "@/components/go-to-link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import {
  addDays,
  isCancellable,
  isConvertibleAdvance,
  isCreditable,
  isOverdue,
} from "@/lib/invoice";
import { isSendable } from "@/lib/mail-send";
import { invoiceDocument } from "@/lib/invoice-document";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague } from "@/lib/number-format";
import { canAmendPayment, canTakePayment } from "@/lib/payments";
import { amountDue, qrStateOf, type QrState } from "@/lib/qr-payload";
import { MAX_SNOOZE_DAYS } from "@/lib/reminders";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { queuedNoticeId } from "@/server/services/bank-notices";
import { db } from "@/server/db";
import { relatedDocuments } from "@/server/services/credit-notes";
import { finalOf } from "@/server/services/invoice-balance";
import { EDITABLE_STATUSES, listVersions } from "@/server/services/invoice-versions";
import { listEmailLog, mailStateOf } from "@/server/services/invoice-mail";
import { getInvoice, type InvoiceDetail } from "@/server/services/invoices";
import { mailAvailability } from "@/server/services/mail-settings";
import { hasDifference, listPayments } from "@/server/services/payments";
import { getRecurring } from "@/server/services/recurring";
import { getPreferences } from "@/server/services/preferences";
import {
  listReminderRules,
  reminderHistory,
  remindersForReview,
} from "@/server/services/reminders";

const T = TEXTS.invoices.detail;

const ACCOUNTS_FIX = { href: "/nastaveni/ucty", label: TEXTS.goTo.accounts };
const QR_FIX: Partial<Record<QrState, { href: string; label: string }>> = {
  no_account: ACCOUNTS_FIX,
  not_czech_account: ACCOUNTS_FIX,
  missing_iban_bic: ACCOUNTS_FIX,
  missing_recipient: { href: "/nastaveni/dodavatel", label: TEXTS.goTo.supplier },
};

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

function StatusSteps({ row, closedMinor }: { row: InvoiceDetail; closedMinor: number }) {
  const left = amountDue(row);
  const isNote = row.type === "credit_note";
  const settled = row.status === "cancelled" || row.status === "credited";
  const steps = [
    { label: T.steps.issued, value: formatDateTime(row.issuedAt) },
    { label: T.steps.sent, value: formatDateTime(row.sentAt) },
    ...(isNote ? [] : [{ label: T.steps.paid, value: formatMoney(row.paidMinor, row.currency) }]),
    ...(row.advanceMinor > 0 && row.status !== "cancelled"
      ? [{ label: T.steps.advance, value: formatMoney(row.advanceMinor, row.currency) }]
      : []),
    ...(closedMinor > 0
      ? [
          {
            label: TEXTS.payments.panel.closedDifference,
            value: formatMoney(closedMinor, row.currency),
          },
        ]
      : []),
    ...(isNote || (settled && left >= 0)
      ? []
      : [
          {
            label: left < 0 ? T.steps.overpaid : T.steps.left,
            value: formatMoney(Math.abs(left), row.currency),
          },
        ]),
  ];
  return (
    <dl
      data-testid="invoice-steps"
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:max-w-md"
    >
      {steps.map((step) => (
        <div key={step.label} className="contents">
          <dt className="text-muted-foreground">{step.label}</dt>
          <dd>{step.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function restoredNotices(query: Record<string, string | string[] | undefined>): string[] {
  if (query.obnoveno !== "1") return [];
  const F = TEXTS.invoices.form;
  return [
    TEXTS.invoices.versions.restored,
    ...(query.zustatek === "overpaid" ? [F.overpaid] : []),
    ...(query.zustatek === "underpaid" ? [F.underpaid] : []),
  ];
}

// The query only opens the offer: sending always takes a click in the dialog.
function sendOffer(
  query: Record<string, string | string[] | undefined>,
  available: boolean,
): string | null {
  if (query.odeslat === "1") return TEXTS.invoices.form.resend;
  return query.vystaveno === "1" && available ? TEXTS.invoiceMail.detail.offerIssued : null;
}

async function DetailContent({ params, searchParams }: PageProps<"/faktury/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const notices = restoredNotices(query);
  const { user } = await requireSession();
  const row = getInvoice(user.id, id);
  if (!row) notFound();
  if (row.status === "draft") redirect(`/faktury/${id}/upravit`);

  const today = calendarDateInPrague(clock.now());
  const editable = EDITABLE_STATUSES.has(row.status) && !row.external;
  const qr = qrStateOf(invoiceDocument(row));
  const emails = listEmailLog(user.id, id);
  const { sending, retrying, problem } = mailStateOf(emails);
  const payments = listPayments(user.id, id);
  const closedMinor = payments
    .filter((item) => item.kind === "difference")
    .reduce((sum, item) => sum + item.creditedMinor, 0);
  const isNote = row.type === "credit_note";
  const isAdvance = row.type === "advance";
  const final = isAdvance ? finalOf(db, user.id, id) : null;
  const takesPayment = canTakePayment(row.status) && !isNote && !row.supersededAt;
  // A credited invoice takes no money, but its refund must stay reachable to be taken back.
  const showsPayments =
    takesPayment || (canAmendPayment(row.status) && !isNote && payments.length > 0);
  const related = relatedDocuments(user.id, id);
  const plan = row.recurringId ? getRecurring(user.id, row.recurringId) : null;
  const sendable = isSendable(row.status) && !row.external;
  const { available } = mailAvailability(user.id);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-brand text-2xl">
          {isNote ? T.creditTitle : isAdvance ? T.advanceTitle : T.title} {row.number}
        </h1>
        <InvoiceStatusBadge status={row.status} overdue={isOverdue(row, today)} />
        {row.supersededAt && <Badge variant="outline">{T.superseded}</Badge>}
        {row.external && (
          <Badge
            variant="outline"
            data-testid="invoice-source"
            render={
              row.importBatchId ? (
                <Link href={`/nastaveni/import/${row.importBatchId}`} />
              ) : undefined
            }
          >
            {row.sourceSystem
              ? TEXTS.importing.source(row.sourceSystem)
              : TEXTS.importing.sourceUnknown}
          </Badge>
        )}
      </div>
      {row.external && <ImportedActions id={id} pdfFileId={row.importPdfFileId} />}
      <p className="text-sm">
        <span className="text-muted-foreground">{T.customer}: </span>
        {row.customerId ? (
          <Link href={`/zakaznici/${row.customerId}`} className="underline underline-offset-4">
            {row.customerName}
          </Link>
        ) : (
          row.customerName
        )}
        {" · "}
        <span className="text-muted-foreground">{T.total}: </span>
        {formatMoney(row.totalMinor, row.currency)}
        {" · "}
        <span className="text-muted-foreground">{T.dueDate}: </span>
        {row.dueDate ? formatCalendarDate(row.dueDate, "d. M. yyyy") : "–"}
      </p>
      {plan && (
        <p className="text-sm" data-testid="invoice-plan">
          <span className="text-muted-foreground">{TEXTS.recurring.fromInvoice.label}: </span>
          <Link href={`/pravidelne/${plan.id}`} className="underline underline-offset-4">
            {plan.name}
          </Link>
        </p>
      )}
      {row.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <Badge
              key={tag.id}
              variant="outline"
              render={<Link href={`/faktury?stitek=${encodeURIComponent(tag.id)}`} />}
            >
              {tag.name}
            </Badge>
          ))}
        </div>
      )}
      {notices.length > 0 && (
        <Alert role="status" data-testid="restored-notice">
          <AlertDescription>{notices.join(" ")}</AlertDescription>
        </Alert>
      )}
      <InvoiceActions
        id={id}
        editable={editable}
        cancellable={isCancellable(row) && !row.external}
        covered={
          isCancellable(row) &&
          row.status !== "issued" &&
          row.status !== "sent" &&
          row.paidMinor === 0
        }
        hasPayments={takesPayment && row.paidMinor > 0}
        hasCredits={row.creditsMinor < 0 && row.status !== "cancelled"}
        hasFinal={final !== null}
        convertible={isConvertibleAdvance(row) && final === null}
        creditable={isCreditable(row) && row.totalMinor + row.creditsMinor > 0}
        copyable={!isNote}
        restorable={row.status === "cancelled" && row.cancelledFrom !== null}
        markable={
          !row.external &&
          (row.status === "issued" ||
            ((row.status === "partially_paid" ||
              row.status === "paid" ||
              row.status === "credited") &&
              row.sentAt === null))
        }
        refreshable={editable && row.customerId !== null}
        mail={{ sendable, available, sending, problem, offer: sendOffer(query, available) }}
      />
      <section className="flex flex-col gap-3">
        <h2 className="text-lg">{T.statusTitle}</h2>
        <StatusSteps row={row} closedMinor={closedMinor} />
        {!isNote && (
          <p data-testid="invoice-qr" className="text-sm text-muted-foreground">
            {TEXTS.invoices.qr[qr]}
            {QR_FIX[qr] && (
              <>
                {" "}
                <GoToLink href={QR_FIX[qr].href}>{QR_FIX[qr].label}</GoToLink>
              </>
            )}
          </p>
        )}
      </section>
      <RelatedDocuments
        parent={related.parent}
        childDocuments={related.children}
        replaced={row.supersededAt !== null}
      />
      {sendable && amountDue(row) > 0 && (
        <ReminderPanel
          invoiceId={id}
          rules={listReminderRules(user.id)}
          history={reminderHistory(user.id, id)}
          suggestedStage={
            remindersForReview(user.id, today).find((item) => item.invoiceId === id)?.stageKey ??
            null
          }
          dateFormat={getPreferences(user.id).dateFormat}
          snoozeUntil={row.remindersSnoozeUntil}
          off={row.remindersOff}
          partial={row.remindersPartial}
          today={today}
          latestSnooze={addDays(today, MAX_SNOOZE_DAYS)}
          canSend={available && !sending}
          sent={row.sentAt !== null}
          queuedNotice={queuedNoticeId(user.id, row.variableSymbol)}
        />
      )}
      {showsPayments && (
        <PaymentPanel
          invoiceId={id}
          revision={row.revision}
          status={row.status}
          currency={row.currency}
          balance={{
            totalMinor: row.totalMinor,
            paidMinor: row.paidMinor,
            creditsMinor: row.creditsMinor,
            advanceMinor: row.advanceMinor,
            supersededAt: row.supersededAt,
          }}
          today={today}
          advance={
            related.parent?.type === "advance"
              ? {
                  ...related.parent,
                  closed: hasDifference(db, user.id, [related.parent.id]),
                }
              : null
          }
          closedFinal={
            final && hasDifference(db, user.id, [final.id])
              ? { id: final.id, number: final.number }
              : null
          }
          payments={payments.map((item) => ({
            id: item.id,
            kind: item.kind,
            source: item.source,
            paidOn: item.paidOn,
            amountMinor: item.amountMinor,
            currency: item.currency,
            creditedMinor: item.creditedMinor,
            method: item.method,
            note: item.note,
            notificationId: item.notificationId,
          }))}
        />
      )}
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{TEXTS.invoices.versions.title}</h2>
        <VersionList invoiceId={id} versions={listVersions(user.id, id)} />
      </section>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{TEXTS.invoiceMail.history.title}</h2>
        <EmailHistory
          invoiceId={id}
          rows={emails}
          sending={sending}
          retrying={retrying}
          canResend={sendable && available}
        />
      </section>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{T.historyTitle}</h2>
        <EntityHistory entity="invoice" entityId={id} />
      </section>
    </>
  );
}

export default function InvoiceDetailPage({ params, searchParams }: PageProps<"/faktury/[id]">) {
  return (
    <>
      <Link
        href="/faktury"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {T.back}
      </Link>
      <Suspense fallback={<PageLoading />}>
        <DetailContent params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}
