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
import { getInvoice } from "@/server/services/invoices";
import { formChoices } from "../../form-data";

const T = TEXTS.invoices.form;

export const metadata: Metadata = { title: `${T.draftTitle} | ${TEXTS.appName}` };

async function EditContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  const row = getInvoice(user.id, id);
  if (!row) notFound();
  const isDraft = row.status === "draft";
  if (!isDraft && !EDITABLE_STATUSES.has(row.status)) redirect(`/faktury/${id}`);

  const choices = formChoices(user.id, row.bankAccountId);
  return (
    <>
      <Link
        href={isDraft ? "/faktury" : `/faktury/${id}`}
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {isDraft ? T.back : T.backToDetail}
      </Link>
      <h1 className="font-brand text-2xl">
        {isDraft ? T.draftTitle : T.issuedTitle(row.number ?? "")}
      </h1>
      <InvoiceForm
        id={id}
        mode={isDraft ? "draft" : "issued"}
        status={row.status}
        number={row.number ?? ""}
        revision={row.revision}
        customerName={row.customerName}
        initial={formFromDocument(row, choices.defaultUnit)}
        initialTags={row.tags.map((tag) => tag.name)}
        initialProblems={isDraft ? checkIssuable(user.id, id) : []}
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
