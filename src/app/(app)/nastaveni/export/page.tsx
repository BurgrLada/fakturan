import type { Metadata } from "next";
import { Suspense } from "react";
import { ExportForm, ExportList } from "@/components/export/export-form";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listExports } from "@/server/services/exports";
import { invoiceFilterOptions } from "@/server/services/invoices";

const T = TEXTS.exporting;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function ExportContent() {
  const { user } = await requireSession();
  return (
    <>
      <ExportForm customers={invoiceFilterOptions(user.id).customers} />
      <h2 className="text-lg font-medium">{T.list.title}</h2>
      <ExportList initial={listExports(user.id)} />
    </>
  );
}

export default function ExportPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <ExportContent />
      </Suspense>
    </>
  );
}
