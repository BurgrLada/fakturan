import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ADVANCE_FORM_PARAM } from "@/lib/invoice";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";

export const metadata: Metadata = { title: `${TEXTS.invoices.form.newTitle} | ${TEXTS.appName}` };

// A signed-in request is redirected by proxy.ts already; this sends anyone else to sign in.
async function NewInvoice({ searchParams }: Pick<PageProps<"/faktury/nova">, "searchParams">) {
  await requireSession();
  const { typ } = await searchParams;
  const query = typ === ADVANCE_FORM_PARAM ? `?typ=${ADVANCE_FORM_PARAM}` : "";
  redirect(`/faktury/${randomUUID()}/upravit${query}`);
  return null;
}

export default function NewInvoicePage({ searchParams }: PageProps<"/faktury/nova">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewInvoice searchParams={searchParams} />
    </Suspense>
  );
}
