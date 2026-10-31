import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RestoreVersion } from "@/components/invoices/version-list";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { diffInvoices } from "@/lib/invoice-diff";
import { invoiceDocument } from "@/lib/invoice-document";
import { TEXTS } from "@/lib/texts";
import {
  changeDetail,
  changeTitle,
  visibleChanges,
  type VersionChange,
  type VersionFormat,
} from "@/lib/version-format";
import { requireSession } from "@/server/auth/session";
import { EDITABLE_STATUSES, getVersion } from "@/server/services/invoice-versions";
import { getInvoice } from "@/server/services/invoices";
import { listSeries } from "@/server/services/number-series";

const T = TEXTS.invoices.versions;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

function Changes({ changes, format }: { changes: VersionChange[]; format: VersionFormat }) {
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">{T.same}</p>;
  return (
    <ul data-testid="version-diff" className="flex flex-col divide-y rounded-md border text-sm">
      {changes.map((change, index) => (
        <li key={index} className="p-2">
          <span className="font-medium">{changeTitle(change)}: </span>
          {changeDetail(change, format)}
        </li>
      ))}
    </ul>
  );
}

async function VersionContent({ params }: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await params;
  const { user } = await requireSession();
  const row = getInvoice(user.id, id);
  const version = getVersion(user.id, versionId);
  if (!row || version?.invoiceId !== id) notFound();
  const current = invoiceDocument(row);
  const series = new Map(listSeries(user.id).map((item) => [item.id, item.name]));
  const format = {
    before: version.document,
    after: current,
    seriesName: (key: string) => series.get(key),
  };

  return (
    <>
      <h1 className="font-brand text-2xl">
        {T.label(version.versionNo)} · {version.document.number}
      </h1>
      <p className="text-sm text-muted-foreground">{formatDateTime(version.createdAt)}</p>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{T.compare}</h2>
        <Changes
          changes={visibleChanges(diffInvoices(version.document, current))}
          format={format}
        />
      </section>
      {EDITABLE_STATUSES.has(row.status) && <RestoreVersion invoiceId={id} versionId={versionId} />}
    </>
  );
}

export default function InvoiceVersionPage({
  params,
}: PageProps<"/faktury/[id]/verze/[versionId]">) {
  return (
    <>
      <Suspense fallback={<PageLoading />}>
        <VersionBack params={params} />
      </Suspense>
      <Suspense fallback={<PageLoading />}>
        <VersionContent params={params} />
      </Suspense>
    </>
  );
}

async function VersionBack({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Link
      href={`/faktury/${id}`}
      className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
    >
      {T.back}
    </Link>
  );
}
