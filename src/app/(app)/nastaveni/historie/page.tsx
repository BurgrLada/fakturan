import { History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import {
  listAudit,
  listAuditFacets,
  parseAuditFilter,
  type AuditFilter,
} from "@/server/services/audit-read";

export const metadata: Metadata = { title: `${TEXTS.history.title} | ${TEXTS.appName}` };

function query(filter: AuditFilter, page?: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filter, page })) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function HistoryContent({
  searchParams,
}: Pick<PageProps<"/nastaveni/historie">, "searchParams">) {
  const { user } = await requireSession();
  const filter = parseAuditFilter(await searchParams);
  const actor = await actorFromRequest();
  const result = listAudit(actor, filter);
  const exportFilter = { ...filter, page: undefined };
  return (
    <>
      <AuditFilters filter={filter} facets={listAuditFacets(actor)} />
      <form method="post" action="/nastaveni/historie/export">
        {Object.entries(exportFilter).map(([name, value]) =>
          value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />,
        )}
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          {TEXTS.history.export}
        </button>
      </form>
      {result.rows.length === 0 ? (
        <EmptyState
          icon={History}
          title={TEXTS.history.title}
          description={TEXTS.history.empty}
          action={
            <Link href="/nastaveni/historie" className={buttonVariants({ variant: "outline" })}>
              {TEXTS.history.reset}
            </Link>
          }
        />
      ) : (
        <AuditTable rows={result.rows} ownerId={user.id} />
      )}
      <div className="flex gap-2">
        {result.page > 1 && (
          <Link
            href={`/nastaveni/historie${query(filter, result.page - 1)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {TEXTS.history.newer}
          </Link>
        )}
        {result.hasNext && (
          <Link
            href={`/nastaveni/historie${query(filter, result.page + 1)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {TEXTS.history.older}
          </Link>
        )}
      </div>
    </>
  );
}

export default function HistoryPage({ searchParams }: PageProps<"/nastaveni/historie">) {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.history.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.history.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <HistoryContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
