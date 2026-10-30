import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CatalogForm } from "@/components/catalog/catalog-form";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listUnits } from "@/server/services/catalog";
import { getPreferences } from "@/server/services/preferences";

const T = TEXTS.catalog;

export const metadata: Metadata = { title: `${T.add} | ${TEXTS.appName}` };

async function NewItemContent() {
  const { user } = await requireSession();
  return (
    <CatalogForm
      initial={null}
      units={listUnits(user.id).map((unit) => unit.name)}
      defaultCurrency={getPreferences(user.id).currency}
    />
  );
}

export default function NewCatalogItemPage() {
  return (
    <>
      <Link href="/cenik" className={buttonVariants({ variant: "ghost", size: "sm" })}>
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.add}</h1>
      <Suspense fallback={<PageLoading />}>
        <NewItemContent />
      </Suspense>
    </>
  );
}
