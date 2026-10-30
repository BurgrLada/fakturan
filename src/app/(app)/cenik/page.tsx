import { Tag } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CatalogFilters } from "@/components/catalog/catalog-filters";
import { CatalogTable } from "@/components/catalog/catalog-table";
import { UnitsPanel } from "@/components/catalog/units-panel";
import { EmptyState } from "@/components/empty-state";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import {
  listCatalog,
  listCategories,
  listUnits,
  parseCatalogFilter,
  type CatalogFilter,
} from "@/server/services/catalog";

const T = TEXTS.catalog;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

const STATUS_PARAM = { active: undefined, archived: "archivovane", all: "vsechny" } as const;

function query(filter: CatalogFilter, page: number): string {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.category) params.set("kategorie", filter.category);
  const status = STATUS_PARAM[filter.status ?? "active"];
  if (status) params.set("stav", status);
  if (filter.sort === "usage") params.set("razeni", "pouziti");
  if (page > 1) params.set("strana", String(page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function CatalogContent({ searchParams }: Pick<PageProps<"/cenik">, "searchParams">) {
  const { user } = await requireSession();
  const filter = parseCatalogFilter(await searchParams);
  const result = listCatalog(user.id, filter);
  const filtered = Boolean(filter.q || filter.category || filter.status);
  return (
    <>
      <CatalogFilters filter={filter} categories={listCategories(user.id)} />
      {result.rows.length === 0 ? (
        <EmptyState
          icon={Tag}
          title={filtered ? T.emptyFiltered : T.empty}
          description={filtered ? "" : T.emptyBody}
          action={
            <Link
              href={filtered ? "/cenik" : "/cenik/novy"}
              className={buttonVariants({ variant: "outline" })}
            >
              {filtered ? T.reset : T.add}
            </Link>
          }
        />
      ) : (
        <CatalogTable rows={result.rows} />
      )}
      <div className="flex gap-2">
        {result.page > 1 && (
          <Link
            href={`/cenik${query(filter, result.page - 1)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {T.newer}
          </Link>
        )}
        {result.hasNext && (
          <Link
            href={`/cenik${query(filter, result.page + 1)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {T.older}
          </Link>
        )}
      </div>
      <UnitsPanel units={listUnits(user.id)} />
    </>
  );
}

export default function CatalogPage({ searchParams }: PageProps<"/cenik">) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-2xl">{T.title}</h1>
        <Link href="/cenik/novy" className={buttonVariants()}>
          {T.add}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <CatalogContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
