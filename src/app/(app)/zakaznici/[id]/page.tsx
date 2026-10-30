import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EntityHistory } from "@/components/audit/entity-history";
import { CustomerActions } from "@/components/customers/customer-actions";
import { CustomerForm, type CustomerValues } from "@/components/customers/customer-form";
import { VatVerify } from "@/components/customers/vat-verify";
import { PageLoading } from "@/components/page-loading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { duplicateIcoOf, getCustomer, type Customer } from "@/server/services/customers";

const T = TEXTS.customers;

export const metadata: Metadata = { title: `${T.detailTitle} | ${TEXTS.appName}` };

// The app shell reads the pathname, so a route needs at least one known param to prerender its shell.
export function generateStaticParams() {
  return [{ id: "novy" }];
}

function toValues(row: Customer): CustomerValues {
  return {
    id: row.id,
    name: row.name,
    street: row.street,
    city: row.city,
    zip: row.zip,
    country: row.country,
    ico: row.ico,
    dic: row.dic,
    email: row.email,
    extraEmails: row.extraEmails.join(", "),
    phone: row.phone,
    note: row.note,
    dueDays: row.dueDays === null ? "" : String(row.dueDays),
    language: row.language ?? "",
    currency: row.currency ?? "",
    designId: row.designId ?? "",
    remindersEnabled: row.remindersEnabled === null ? "" : row.remindersEnabled ? "1" : "0",
  };
}

function vatLine(row: Customer): string {
  if (!row.vatVerifiedAt) return T.vat.never;
  const outcome = row.vatValid ? T.vat.valid : T.vat.invalid;
  return `${outcome} ${T.vat.lastChecked(formatDateTime(row.vatVerifiedAt))}`;
}

async function CustomerContent({ params }: Pick<PageProps<"/zakaznici/[id]">, "params">) {
  const { id } = await params;
  const { user } = await requireSession();
  if (id === "novy") return <CustomerForm initial={null} />;
  const row = getCustomer(user.id, id);
  if (!row) notFound();
  const duplicate = duplicateIcoOf(db, user.id, row);
  return (
    <>
      {duplicate && (
        <Alert role="status" className="sm:max-w-xl">
          <AlertDescription>{T.duplicateIco(duplicate)}</AlertDescription>
        </Alert>
      )}
      <CustomerForm key={row.updatedAt.getTime()} initial={toValues(row)} />
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{T.vat.title}</h2>
        <p className="text-sm text-muted-foreground">{vatLine(row)}</p>
        <VatVerify id={row.id} hasVatId={row.dic !== ""} />
      </section>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <p className="text-sm text-muted-foreground">{T.stats}</p>
        <CustomerActions id={row.id} archived={row.archivedAt !== null} />
      </section>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{T.historyTitle}</h2>
        <EntityHistory entity="customer" entityId={row.id} />
      </section>
    </>
  );
}

export default function CustomerPage({ params }: PageProps<"/zakaznici/[id]">) {
  return (
    <>
      <Link href="/zakaznici" className={buttonVariants({ variant: "ghost", size: "sm" })}>
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.detailTitle}</h1>
      <Suspense fallback={<PageLoading />}>
        <CustomerContent params={params} />
      </Suspense>
    </>
  );
}
