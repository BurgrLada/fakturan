import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { auditActionLabel } from "@/lib/audit-labels";
import { TEXTS } from "@/lib/texts";
import { AUDIT_SOURCES, type AuditFilter } from "@/server/services/audit-read";
import Link from "next/link";

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export function AuditFilters({
  filter,
  facets,
}: {
  filter: AuditFilter;
  facets: { actions: string[]; entities: string[] };
}) {
  return (
    <form
      method="get"
      action="/nastaveni/historie"
      aria-label={TEXTS.history.filters}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      <Field id="f-action" label={TEXTS.history.action}>
        <NativeSelect id="f-action" name="action" defaultValue={filter.action ?? ""}>
          <option value="">{TEXTS.history.all}</option>
          {facets.actions.map((action) => (
            <option key={action} value={action}>
              {auditActionLabel(action)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="f-entity" label={TEXTS.history.entity}>
        <NativeSelect id="f-entity" name="entity" defaultValue={filter.entity ?? ""}>
          <option value="">{TEXTS.history.all}</option>
          {facets.entities.map((entity) => (
            <option key={entity} value={entity}>
              {entity}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="f-source" label={TEXTS.history.source}>
        <NativeSelect id="f-source" name="source" defaultValue={filter.source ?? ""}>
          <option value="">{TEXTS.history.all}</option>
          {AUDIT_SOURCES.map((source) => (
            <option key={source} value={source}>
              {TEXTS.history.sources[source]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="f-actor" label={TEXTS.history.actor}>
        <NativeSelect id="f-actor" name="actor" defaultValue={filter.actor ?? ""}>
          <option value="">{TEXTS.history.all}</option>
          <option value="self">{TEXTS.history.actorSelf}</option>
          <option value="other">{TEXTS.history.actorOther}</option>
        </NativeSelect>
      </Field>
      <Field id="f-from" label={TEXTS.history.from}>
        <Input id="f-from" name="from" type="date" defaultValue={filter.from ?? ""} />
      </Field>
      <Field id="f-to" label={TEXTS.history.to}>
        <Input id="f-to" name="to" type="date" defaultValue={filter.to ?? ""} />
      </Field>
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit">{TEXTS.history.apply}</Button>
        <Link href="/nastaveni/historie" className={buttonVariants({ variant: "outline" })}>
          {TEXTS.history.reset}
        </Link>
      </div>
    </form>
  );
}
