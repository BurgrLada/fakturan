"use client";

import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { saveDesignAction, type DesignChoiceInput } from "@/app/(app)/nastaveni/designy/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { contrastRatio, isHexColor, MIN_TEXT_CONTRAST } from "@/lib/contrast";
import { LOGO_POSITIONS, type LogoPosition } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.designs;

const PREVIEW_DELAY_MS = 400;
const PAGE_COLOR = "#ffffff";

const COLOR_FIELDS = [
  { role: "accent", name: "accentColor", query: "accent" },
  { role: "surface", name: "surfaceColor", query: "surface" },
  { role: "text", name: "textColor", query: "text" },
  { role: "line", name: "lineColor", query: "line" },
] as const;

export type DesignOption = {
  id: string;
  name: string;
  colors: Record<(typeof COLOR_FIELDS)[number]["role"], string>;
};

function previewUrl(values: DesignChoiceInput): string | null {
  const colors = COLOR_FIELDS.map(({ name, query }): [string, string] => [query, values[name]]);
  if (colors.some(([, color]) => color && !isHexColor(color))) return null;
  const query = new URLSearchParams([
    ["design", values.designId],
    ...colors,
    ["logo", values.logoPosition],
  ]);
  return `/nastaveni/designy/nahled?${query}`;
}

function contrastWarnings(text: string, surface: string, accent: string): string[] {
  if (![text, surface, accent].every(isHexColor)) return [];
  return [
    { where: T.onPage, ratio: contrastRatio(text, PAGE_COLOR) },
    { where: T.onSurface, ratio: contrastRatio(text, surface) },
    { where: T.accentOnPage, ratio: contrastRatio(accent, PAGE_COLOR) },
  ]
    .filter(({ ratio }) => ratio < MIN_TEXT_CONTRAST)
    .map(({ where, ratio }) => T.lowContrast(where, ratio.toFixed(1).replace(".", ",")));
}

export function DesignPicker({
  designs,
  initial,
}: {
  designs: DesignOption[];
  initial: DesignChoiceInput;
}) {
  const [values, setValues] = useState(initial);
  const [preview, setPreview] = useState(() => previewUrl(initial));
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const design = designs.find((option) => option.id === values.designId) ?? designs[0]!;
  const set = (patch: Partial<DesignChoiceInput>) =>
    setValues((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const next = previewUrl(values);
    if (!next) return;
    const timer = setTimeout(() => setPreview(next), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [values]);

  const warnings = useMemo(
    () =>
      contrastWarnings(
        values.textColor || design.colors.text,
        values.surfaceColor || design.colors.surface,
        values.accentColor || design.colors.accent,
      ),
    [values.textColor, values.surfaceColor, values.accentColor, design],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveDesignAction(values);
      setMessage(result.ok ? { ok: true, text: T.saved } : { ok: false, text: result.error });
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <form onSubmit={submit} className="flex flex-col gap-6">
        {message && (
          <Alert variant={message.ok ? "default" : "destructive"} role="status">
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-lg">{T.pick}</legend>
          <div className="grid grid-cols-2 gap-1">
            {designs.map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:bg-muted has-checked:border-primary"
              >
                <input
                  type="radio"
                  name="designId"
                  className="size-4 accent-primary"
                  value={option.id}
                  checked={values.designId === option.id}
                  onChange={() => set({ designId: option.id })}
                />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full border"
                  style={{ backgroundColor: option.colors.accent }}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="text-lg">{T.colors}</legend>
          <p className="text-sm text-muted-foreground">{T.colorsHint}</p>
          {COLOR_FIELDS.map(({ role, name }) => {
            const id = `design-${role}`;
            const custom = values[name];
            return (
              <div key={role} className="flex flex-col gap-2">
                <Label htmlFor={id}>{T.color[role]}</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={T.colorPicker(T.color[role])}
                    className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-background p-1"
                    value={isHexColor(custom) ? custom.toLowerCase() : design.colors[role]}
                    onChange={(event) => set({ [name]: event.target.value })}
                  />
                  <Input
                    id={id}
                    value={custom}
                    placeholder={design.colors[role]}
                    aria-invalid={custom !== "" && !isHexColor(custom)}
                    onChange={(event) => set({ [name]: event.target.value.trim() })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={custom === ""}
                    aria-label={`${T.useDesignColor}: ${T.color[role]}`}
                    onClick={() => set({ [name]: "" })}
                  >
                    {T.useDesignColor}
                  </Button>
                </div>
              </div>
            );
          })}
          {warnings.map((warning) => (
            <Alert key={warning} role="status">
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor="design-logo">{T.logoPosition}</Label>
          <NativeSelect
            id="design-logo"
            value={values.logoPosition}
            onChange={(event) => set({ logoPosition: event.target.value as LogoPosition })}
          >
            {LOGO_POSITIONS.map((position) => (
              <option key={position} value={position}>
                {T.logoPositions[position]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {T.save}
          </Button>
        </div>
      </form>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg">{T.preview}</h2>
        <p className="text-sm text-muted-foreground">{T.previewHint}</p>
        {preview && (
          <iframe
            title={T.preview}
            src={preview}
            className="aspect-[1/1.414] w-full rounded-md border bg-background"
          />
        )}
      </section>
    </div>
  );
}
