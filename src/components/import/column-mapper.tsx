"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  deletePresetAction,
  savePresetAction,
  submitMappingAction,
} from "@/app/(app)/nastaveni/import/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES } from "@/lib/currency";
import {
  applyMapping,
  DATE_FORMATS,
  DECIMAL_SEPARATORS,
  defaultMapping,
  fieldLabel,
  fieldsOf,
  MAPPING_FIELDS,
  MAPPING_TARGETS,
  missingColumns,
  type Mapping,
  type MappingTarget,
  type MappedValue,
  type TabularSample,
} from "@/lib/import-mapping";
import type { PresetView } from "@/lib/import-presets";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.importing;
const M = T.mapping;

type Props = {
  batchId: string;
  revision: number;
  sample: TabularSample;
  presets: PresetView[];
  initial: Mapping;
};

// Integer digits only: a scaled amount from the file is never turned into a float for display.
function scaled(value: number, scale: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(value)).padStart(scale + 1, "0");
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  const whole = digits.slice(0, -scale);
  return `${sign}${whole}${fraction ? `,${fraction}` : ""}`;
}

function shown(target: MappingTarget, field: string, value: MappedValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  const kind = (MAPPING_FIELDS[target] as Record<string, { kind: string }>)[field]?.kind;
  if (kind === "money") return scaled(value, 2);
  if (kind === "quantity") return scaled(value, 3);
  if (kind === "rate") return scaled(value, 6);
  return String(value);
}

export function ColumnMapper({
  batchId,
  revision,
  sample,
  presets: initialPresets,
  initial,
}: Props) {
  const router = useRouter();
  const [mapping, setMapping] = useState<Mapping>(initial);
  const [presets, setPresets] = useState(initialPresets);
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const fields = fieldsOf(mapping.target);
  const used = fields.filter(([field]) => mapping.columns[field]);
  const mapped = useMemo(() => applyMapping(sample, mapping), [sample, mapping]);
  const forTarget = presets.filter((preset) => preset.target === mapping.target);
  const chosen = presets.find((preset) => preset.id === presetId) ?? null;
  const absent = chosen ? missingColumns(sample.headers, chosen.mapping) : [];

  const update = (next: Partial<Mapping>) => setMapping((current) => ({ ...current, ...next }));
  const setColumn = (field: string, column: string) =>
    setMapping((current) => {
      const columns = { ...current.columns };
      if (column) columns[field] = column;
      else delete columns[field];
      return { ...current, columns };
    });

  const pickTarget = (target: MappingTarget) => {
    setPresetId("");
    setMapping((current) => ({
      ...defaultMapping(target, sample.headers),
      dateFormat: current.dateFormat,
      decimal: current.decimal,
      currency: current.currency,
      source: current.source,
    }));
  };

  const pickPreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((item) => item.id === id);
    if (preset) setMapping(preset.mapping);
  };

  const run = (work: () => Promise<void>) =>
    startTransition(async () => {
      setError(null);
      setNotice(null);
      await work();
    });

  const submit = () =>
    run(async () => {
      const result = await submitMappingAction({ batchId, revision, mapping });
      if (!result.ok) return setError(result.error);
      router.refresh();
    });

  const save = () =>
    run(async () => {
      const result = await savePresetAction({ name: presetName, mapping });
      if (!result.ok) return setError(result.error);
      setPresets(result.presets);
      setPresetId(result.id);
      setNotice(M.presetSaved);
    });

  const remove = () =>
    run(async () => {
      if (!chosen || chosen.builtIn || !window.confirm(M.deleteConfirm)) return;
      const result = await deletePresetAction({ id: chosen.id });
      if (!result.ok) return setError(result.error);
      setPresets(result.presets);
      setPresetId("");
    });

  return (
    <section className="space-y-4" aria-labelledby="mapping-title">
      <div className="space-y-1">
        <h2 id="mapping-title" className="text-lg font-medium">
          {M.title}
        </h2>
        <p className="text-sm text-muted-foreground">{M.intro}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="mapping-target">{M.target}</Label>
          <NativeSelect
            id="mapping-target"
            value={mapping.target}
            onChange={(event) => pickTarget(event.target.value as MappingTarget)}
          >
            {MAPPING_TARGETS.map((target) => (
              <option key={target} value={target}>
                {T.targets[target]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mapping-preset">{M.preset}</Label>
          <div className="flex gap-2">
            <NativeSelect
              id="mapping-preset"
              value={presetId}
              onChange={(event) => pickPreset(event.target.value)}
            >
              <option value="">{M.presetNone}</option>
              {forTarget.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                  {preset.builtIn ? ` (${M.builtIn})` : ""}
                </option>
              ))}
            </NativeSelect>
            {chosen && !chosen.builtIn && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={remove}>
                {M.deletePreset}
              </Button>
            )}
          </div>
          {absent.length > 0 && (
            <p className="text-xs text-destructive">{M.presetMissing(absent.join(", "))}</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([field, spec]) => (
          <div key={field} className="space-y-1">
            <Label htmlFor={`map-${field}`}>
              {fieldLabel(mapping.target, field)}
              {spec.required ? ` (${M.required})` : ""}
            </Label>
            <NativeSelect
              id={`map-${field}`}
              value={mapping.columns[field] ?? ""}
              onChange={(event) => setColumn(field, event.target.value)}
            >
              <option value="">{M.unused}</option>
              {sample.headers
                .filter((header) => header)
                .map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
            </NativeSelect>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="mapping-date">{M.dateFormat}</Label>
          <NativeSelect
            id="mapping-date"
            value={mapping.dateFormat}
            onChange={(event) =>
              update({ dateFormat: event.target.value as Mapping["dateFormat"] })
            }
          >
            {DATE_FORMATS.map((format) => (
              <option key={format} value={format}>
                {M.dateFormats[format]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mapping-decimal">{M.decimal}</Label>
          <NativeSelect
            id="mapping-decimal"
            value={mapping.decimal}
            onChange={(event) => update({ decimal: event.target.value as Mapping["decimal"] })}
          >
            {DECIMAL_SEPARATORS.map((separator) => (
              <option key={separator} value={separator}>
                {M.decimals[separator]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mapping-currency">{M.currency}</Label>
          <NativeSelect
            id="mapping-currency"
            value={mapping.currency}
            onChange={(event) => update({ currency: event.target.value as Mapping["currency"] })}
          >
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </NativeSelect>
        </div>
        {mapping.target === "invoices" && (
          <div className="space-y-1">
            <Label htmlFor="mapping-source">{M.source}</Label>
            <Input
              id="mapping-source"
              value={mapping.source}
              maxLength={200}
              onChange={(event) => update({ source: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{M.sourceHint}</p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{M.sample}</h3>
        <p className="text-xs text-muted-foreground">
          {M.shown(Math.min(sample.rows.length, sample.total), sample.total)}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={M.sample}>
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">{M.lineHeader}</th>
                {used.map(([field]) => (
                  <th key={field} className="p-2">
                    {fieldLabel(mapping.target, field)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mapped.map((row) => (
                <tr key={row.line} className="border-b align-top">
                  <td className="p-2 tabular-nums">{row.line}</td>
                  {used.map(([field]) => (
                    <td key={field} className="max-w-48 truncate p-2">
                      {shown(mapping.target, field, row.values[field])}
                    </td>
                  ))}
                  {row.errors.length > 0 && (
                    <td className="p-2 text-xs text-destructive">
                      {row.errors.map((message) => (
                        <p key={message}>{message}</p>
                      ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="preset-name">{M.presetName}</Label>
          <Input
            id="preset-name"
            value={presetName}
            maxLength={80}
            onChange={(event) => setPresetName(event.target.value)}
          />
        </div>
        <Button variant="outline" disabled={pending || !presetName.trim()} onClick={save}>
          {M.savePreset}
        </Button>
      </div>

      {notice && (
        <p className="text-sm" role="status">
          {notice}
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button disabled={pending} onClick={submit}>
        {M.continue}
      </Button>
    </section>
  );
}
