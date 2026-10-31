import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { formFromDocument } from "@/lib/invoice-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { checkIssuable } from "@/server/services/invoice-lifecycle";
import { EDITABLE_STATUSES } from "@/server/services/invoice-versions";
import { designChoices } from "@/server/pdf/designs";
import { getInvoice, isFreeDraftId, newDraftDefaults } from "@/server/services/invoices";
import { formChoices } from "../../form-data";

const T = TEXTS.invoices.form;

export const metadata: Metadata = { title: `${T.draftTitle} | ${TEXTS.appName}` };

function newDocument(ownerId: string) {
  const defaults = newDraftDefaults(ownerId, null);
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

async function EditContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  const row = getInvoice(user.id, id);
  if (!row && !isFreeDraftId(id)) notFound();
  const isDraft = !row || row.status === "draft";
  if (row && !isDraft && !EDITABLE_STATUSES.has(row.status)) redirect(`/faktury/${id}`);

  const choices = formChoices(user.id, row?.bankAccountId ?? null);
  const title = !row ? T.newTitle : isDraft ? T.draftTitle : T.issuedTitle(row.number ?? "");
  return (
    <>
      <Link
        href={isDraft ? "/faktury" : `/faktury/${id}`}
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {isDraft ? T.back : T.backToDetail}
      </Link>
      <h1 className="font-brand text-2xl">{title}</h1>
      <InvoiceForm
        id={id}
        saved={row !== null}
        type={row?.type ?? "invoice"}
        mode={isDraft ? "draft" : "issued"}
        status={row?.status ?? "draft"}
        number={row?.number ?? ""}
        variableSymbol={row?.variableSymbol ?? ""}
        revision={row?.revision ?? 0}
        customerName={row?.customerName ?? ""}
        initial={formFromDocument(row ?? newDocument(user.id), choices.defaultUnit)}
        initialTags={row?.tags.map((tag) => tag.name) ?? []}
        initialProblems={row && isDraft ? checkIssuable(user.id, id) : []}
        designs={designChoices()}
        {...choices}
      />
    </>
  );
}

export default function EditInvoicePage({ params }: PageProps<"/faktury/[id]/upravit">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <EditContent params={params} />
    </Suspense>
  );
}
