import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { ADVANCE_FORM_PARAM, type InvoiceType } from "@/lib/invoice";
import { formFromDocument } from "@/lib/invoice-form";
import { TEXTS } from "@/lib/texts";
import { formatMoney } from "@/lib/money";
import { requireSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { creditableMinor } from "@/server/services/credit-notes";
import { getCustomer } from "@/server/services/customers";
import { finalOf } from "@/server/services/invoice-balance";
import { checkIssuable } from "@/server/services/invoice-lifecycle";
import { EDITABLE_STATUSES } from "@/server/services/invoice-versions";
import { designChoices } from "@/server/pdf/designs";
import { getInvoice, isFreeDraftId, newDraftDefaults } from "@/server/services/invoices";
import { mailAvailability } from "@/server/services/mail-settings";
import { listPayments } from "@/server/services/payments";
import { formChoices } from "../../form-data";

const T = TEXTS.invoices.form;

export const metadata: Metadata = { title: `${T.draftTitle} | ${TEXTS.appName}` };

function newDocument(ownerId: string, type: InvoiceType) {
  const defaults = newDraftDefaults(ownerId, null, type);
  return {
    ...defaults,
    customerId: null,
    seriesId: defaults.seriesId ?? null,
    bankAccountId: defaults.bankAccountId ?? null,
    taxableDate: null,
    issueDate: defaults.issueDate ?? null,
    dueDate: defaults.dueDate ?? null,
    lines: [],
  } as Parameters<typeof formFromDocument>[0];
}

function titleOf(type: InvoiceType, row: { number: string | null } | null, isDraft: boolean) {
  const number = row?.number ?? "";
  if (type === "advance") {
    if (!row) return T.advanceNewTitle;
    return isDraft ? T.advanceDraftTitle : T.advanceIssuedTitle(number);
  }
  if (!row) return T.newTitle;
  if (type === "credit_note") return isDraft ? T.creditDraftTitle : T.creditIssuedTitle(number);
  return isDraft ? T.draftTitle : T.issuedTitle(number);
}

async function EditContent({ params, searchParams }: PageProps<"/faktury/[id]/upravit">) {
  const { id } = await params;
  const { typ } = await searchParams;
  const { user } = await requireSession();
  const row = getInvoice(user.id, id);
  if (!row && !isFreeDraftId(user.id, id)) notFound();
  const isDraft = !row || row.status === "draft";
  if (row && !isDraft && !EDITABLE_STATUSES.has(row.status)) redirect(`/faktury/${id}`);

  const type = row?.type ?? (typ === ADVANCE_FORM_PARAM ? "advance" : "invoice");
  const choices = formChoices(user.id, row?.bankAccountId ?? null, type);
  const isNote = type === "credit_note";
  const customerDic =
    row?.customerSnapshot?.dic ??
    (row?.customerId ? getCustomer(user.id, row.customerId)?.dic : undefined) ??
    "";
  const title = titleOf(type, row, isDraft);
  const hasFinal = type === "advance" && finalOf(db, user.id, id) !== null;
  const creditLeft =
    isNote && row?.relatedInvoiceId
      ? T.creditLeft(
          formatMoney(creditableMinor(db, user.id, row.relatedInvoiceId, row.id), row.currency),
        )
      : null;
  return (
    <>
      <Link
        href={isDraft ? "/faktury" : `/faktury/${id}`}
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {isDraft ? T.back : T.backToDetail}
      </Link>
      <h1 className="font-brand text-2xl">{title}</h1>
      {creditLeft && (
        <p data-testid="credit-left" className="text-sm text-muted-foreground">
          {creditLeft}
        </p>
      )}
      <InvoiceForm
        id={id}
        saved={row !== null}
        mailAvailable={mailAvailability(user.id).available}
        hasPayments={row !== null && !isDraft && listPayments(user.id, id).length > 0}
        linkedParty={row?.relatedInvoiceId != null || hasFinal}
        linkedMoney={row !== null && (isNote || row.creditsMinor < 0)}
        type={type}
        mode={isDraft ? "draft" : "issued"}
        status={row?.status ?? "draft"}
        number={row?.number ?? ""}
        variableSymbol={row?.variableSymbol ?? ""}
        revision={row?.revision ?? 0}
        customerName={row?.customerName ?? ""}
        customerDic={customerDic}
        rateListDate={row?.exchangeRateDate ?? null}
        initial={formFromDocument(row ?? newDocument(user.id, type), choices.defaultUnit)}
        initialTags={row?.tags.map((tag) => tag.name) ?? []}
        initialProblems={row && isDraft ? checkIssuable(user.id, id) : []}
        designs={designChoices()}
        {...choices}
      />
    </>
  );
}

export default function EditInvoicePage({
  params,
  searchParams,
}: PageProps<"/faktury/[id]/upravit">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <EditContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}
