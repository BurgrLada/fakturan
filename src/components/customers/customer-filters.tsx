import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { TEXTS } from "@/lib/texts";
import type { CustomerFilter } from "@/server/services/customers";

const T = TEXTS.customers;

const STATUS_PARAM = { active: "", archived: "archivovani", all: "vsichni" } as const;

export function CustomerFilters({ filter }: { filter: CustomerFilter }) {
  return (
    <form
      method="get"
      action="/zakaznici"
      aria-label={T.filters}
      className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
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
        <Label htmlFor="f-zahranici">{T.kind}</Label>
        <NativeSelect id="f-zahranici" name="zahranici" defaultValue={filter.foreign ? "1" : ""}>
          <option value="">{T.kinds.all}</option>
          <option value="1">{T.kinds.foreign}</option>
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
          <option value="archivovani">{T.statuses.archived}</option>
          <option value="vsichni">{T.statuses.all}</option>
        </NativeSelect>
      </div>
      <div className="flex gap-2">
        <Button type="submit">{T.apply}</Button>
        <Link href="/zakaznici" className={buttonVariants({ variant: "outline" })}>
          {T.reset}
        </Link>
      </div>
    </form>
  );
}
