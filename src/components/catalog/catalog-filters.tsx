import Link from "next/link";
import { FilterField } from "@/components/filter-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { TEXTS } from "@/lib/texts";
import type { CatalogFilter } from "@/server/services/catalog";

const T = TEXTS.catalog;

const STATUS_PARAM = { active: "", archived: "archivovane", all: "vsechny" } as const;

export function CatalogFilters({
  filter,
  categories,
}: {
  filter: CatalogFilter;
  categories: string[];
}) {
  return (
    <form
      method="get"
      action="/cenik"
      aria-label={T.filters}
      className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-5"
    >
      <FilterField label={T.search}>
        <Input
          name="q"
          type="search"
          defaultValue={filter.q ?? ""}
          placeholder={T.searchPlaceholder}
        />
      </FilterField>
      <FilterField label={T.category}>
        <NativeSelect name="kategorie" defaultValue={filter.category ?? ""}>
          <option value="">{T.allCategories}</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </NativeSelect>
      </FilterField>
      <FilterField label={T.status}>
        <NativeSelect name="stav" defaultValue={STATUS_PARAM[filter.status ?? "active"]}>
          <option value="">{T.statuses.active}</option>
          <option value="archivovane">{T.statuses.archived}</option>
          <option value="vsechny">{T.statuses.all}</option>
        </NativeSelect>
      </FilterField>
      <FilterField label={T.sort}>
        <NativeSelect name="razeni" defaultValue={filter.sort === "usage" ? "pouziti" : ""}>
          <option value="">{T.sorts.name}</option>
          <option value="pouziti">{T.sorts.usage}</option>
        </NativeSelect>
      </FilterField>
      <div className="flex gap-2">
        <Button type="submit">{T.apply}</Button>
        <Link href="/cenik" className={buttonVariants({ variant: "outline" })}>
          {T.reset}
        </Link>
      </div>
    </form>
  );
}
