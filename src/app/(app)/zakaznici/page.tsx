import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CustomerFilters } from "@/components/customers/customer-filters";
import { CustomerTable } from "@/components/customers/customer-table";
import { EmptyState } from "@/components/empty-state";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import {
  listCustomers,
  parseCustomerFilter,
  type CustomerFilter,
} from "@/server/services/customers";

const T = TEXTS.customers;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

const STATUS_PARAM = { active: undefined, archived: "archivovani", all: "vsichni" } as const;

function query(filter: CustomerFilter, page: number): string {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.foreign) params.set("zahranici", "1");
  const status = STATUS_PARAM[filter.status ?? "active"];
  if (status) params.set("stav", status);
  if (page > 1) params.set("strana", String(page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function CustomersContent({ searchParams }: Pick<PageProps<"/zakaznici">, "searchParams">) {
  const { user } = await requireSession();
  const filter = parseCustomerFilter(await searchParams);
  const result = listCustomers(user.id, filter);
  const filtered = Boolean(filter.q || filter.foreign || filter.status);
  return (
    <>
      <CustomerFilters filter={filter} />
      {result.rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filtered ? T.emptyFiltered : T.empty}
          description={filtered ? "" : T.emptyBody}
          action={
            <Link
              href={filtered ? "/zakaznici" : "/zakaznici/novy"}
              className={buttonVariants({ variant: "outline" })}
            >
              {filtered ? T.reset : T.add}
            </Link>
          }
        />
      ) : (
        <CustomerTable rows={result.rows} />
      )}
      <div className="flex gap-2">
        {result.page > 1 && (
          <Link
            href={`/zakaznici${query(filter, result.page - 1)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {T.newer}
          </Link>
        )}
        {result.hasNext && (
          <Link
            href={`/zakaznici${query(filter, result.page + 1)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {T.older}
          </Link>
        )}
      </div>
    </>
  );
}

export default function CustomersPage({ searchParams }: PageProps<"/zakaznici">) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-2xl">{T.title}</h1>
        <Link href="/zakaznici/novy" className={buttonVariants()}>
          {T.add}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <CustomersContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
