import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { formFromDocument } from "@/lib/invoice-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { newDraftDefaults } from "@/server/services/invoices";
import { formChoices } from "../form-data";

const T = TEXTS.invoices.form;

export const metadata: Metadata = { title: `${T.newTitle} | ${TEXTS.appName}` };

async function NewInvoiceContent() {
  const { user } = await requireSession();
  const defaults = newDraftDefaults(user.id, null);
  const choices = formChoices(user.id, null);
  const initial = formFromDocument(
    {
      ...defaults,
      customerId: null,
      seriesId: defaults.seriesId ?? null,
      bankAccountId: defaults.bankAccountId ?? null,
      taxableDate: null,
      issueDate: defaults.issueDate ?? null,
      dueDate: defaults.dueDate ?? null,
      lines: [],
    } as Parameters<typeof formFromDocument>[0],
    choices.defaultUnit,
  );
  return (
    <InvoiceForm
      id={null}
      mode="draft"
      status="draft"
      number=""
      revision={0}
      customerName=""
      initial={initial}
      initialTags={[]}
      initialProblems={[]}
      {...choices}
    />
  );
}

export default function NewInvoicePage() {
  return (
    <>
      <Link
        href="/faktury"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.newTitle}</h1>
      <Suspense fallback={<PageLoading />}>
        <NewInvoiceContent />
      </Suspense>
    </>
  );
}
