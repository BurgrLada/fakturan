import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-q">{T.search}</Label>
        <Input
          id="f-q"
          name="q"
          type="search"
          defaultValue={filter.q ?? ""}
          placeholder={T.searchPlaceholder}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-kategorie">{T.category}</Label>
        <NativeSelect id="f-kategorie" name="kategorie" defaultValue={filter.category ?? ""}>
          <option value="">{T.allCategories}</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-stav">{T.status}</Label>
        <NativeSelect
          id="f-stav"
          name="stav"
          defaultValue={STATUS_PARAM[filter.status ?? "active"]}
        >
          <option value="">{T.statuses.active}</option>
          <option value="archivovane">{T.statuses.archived}</option>
          <option value="vsechny">{T.statuses.all}</option>
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-razeni">{T.sort}</Label>
        <NativeSelect
          id="f-razeni"
          name="razeni"
          defaultValue={filter.sort === "usage" ? "pouziti" : ""}
        >
          <option value="">{T.sorts.name}</option>
          <option value="pouziti">{T.sorts.usage}</option>
        </NativeSelect>
      </div>
      <div className="flex gap-2">
        <Button type="submit">{T.apply}</Button>
        <Link href="/cenik" className={buttonVariants({ variant: "outline" })}>
          {T.reset}
        </Link>
      </div>
    </form>
  );
}
