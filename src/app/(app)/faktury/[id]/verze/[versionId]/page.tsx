import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RestoreVersion } from "@/components/invoices/version-list";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import type { Currency } from "@/lib/currency";
import { formatDateTime } from "@/lib/format";
import { diffInvoices, type InvoiceChange } from "@/lib/invoice-diff";
import { invoiceDocument } from "@/lib/invoice-document";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { EDITABLE_STATUSES, getVersion } from "@/server/services/invoice-versions";
import { getInvoice } from "@/server/services/invoices";

const T = TEXTS.invoices.versions;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

type FieldChange = Extract<InvoiceChange, { kind: "field" }>;

function fieldLabel(field: string): string {
  return (T.fields as Record<string, string>)[field] ?? T.otherField;
}

function fieldValue(change: FieldChange, side: "before" | "after", currency: Currency): string {
  const value = change[side];
  if (value === null || value === "") return "–";
  if (change.field.endsWith("Minor")) return formatMoney(Number(value), currency);
  return String(value);
}

function Changes({ changes, currency }: { changes: InvoiceChange[]; currency: Currency }) {
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">{T.same}</p>;
  return (
    <ul data-testid="version-diff" className="flex flex-col divide-y rounded-md border text-sm">
      {changes.map((change, index) => (
        <li key={index} className="p-2">
          {change.kind === "field" ? (
            <>
              <span className="font-medium">{fieldLabel(change.field)}: </span>
              {fieldValue(change, "before", currency)} → {fieldValue(change, "after", currency)}
            </>
          ) : (
            <>
              <span className="font-medium">{T.line[change.change]}: </span>
              {(change.after ?? change.before)?.name}
            </>
          )}
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

  return (
    <>
      <h1 className="font-brand text-2xl">
        {T.label(version.versionNo)} · {version.document.number}
      </h1>
      <p className="text-sm text-muted-foreground">{formatDateTime(version.createdAt)}</p>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{T.compare}</h2>
        <Changes
          changes={diffInvoices(version.document, invoiceDocument(row))}
          currency={row.currency}
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
