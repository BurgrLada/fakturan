import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EntityHistory } from "@/components/audit/entity-history";
import { CatalogActions } from "@/components/catalog/catalog-actions";
import { CatalogForm } from "@/components/catalog/catalog-form";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { formatMoneyInput } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getCatalogItem, listUnits } from "@/server/services/catalog";
import { getPreferences } from "@/server/services/preferences";

const T = TEXTS.catalog;

export const metadata: Metadata = { title: `${T.detailTitle} | ${TEXTS.appName}` };

async function CatalogItemContent({ params }: Pick<PageProps<"/cenik/[id]">, "params">) {
  const { id } = await params;
  const { user } = await requireSession();
  const row = getCatalogItem(user.id, id);
  if (!row) notFound();
  return (
    <>
      <CatalogForm
        initial={{
          id: row.id,
          name: row.name,
          description: row.description,
          unit: row.unit,
          price: formatMoneyInput(row.priceMinor),
          currency: row.currency,
          category: row.category,
          tags: row.tags.join(", "),
        }}
        units={listUnits(user.id).map((unit) => unit.name)}
        defaultCurrency={getPreferences(user.id).currency}
      />
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <CatalogActions id={row.id} archived={row.archivedAt !== null} />
      </section>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{T.historyTitle}</h2>
        <EntityHistory entity="catalog_item" entityId={row.id} />
      </section>
    </>
  );
}

export default function CatalogItemPage({ params }: PageProps<"/cenik/[id]">) {
  return (
    <>
      <Link href="/cenik" className={buttonVariants({ variant: "ghost", size: "sm" })}>
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.detailTitle}</h1>
      <Suspense fallback={<PageLoading />}>
        <CatalogItemContent params={params} />
      </Suspense>
    </>
  );
}
