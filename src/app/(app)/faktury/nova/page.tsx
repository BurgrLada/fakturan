import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";

export const metadata: Metadata = { title: `${TEXTS.invoices.form.newTitle} | ${TEXTS.appName}` };

// A signed-in request is redirected by proxy.ts already; this sends anyone else to sign in.
async function NewInvoice() {
  await requireSession();
  redirect(`/faktury/${randomUUID()}/upravit`);
  return null;
}

export default function NewInvoicePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewInvoice />
    </Suspense>
  );
}
