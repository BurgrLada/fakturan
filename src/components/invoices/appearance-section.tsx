"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { Appearance } from "@/lib/invoice";
import { LOGO_POSITIONS, type DesignChoice, type LogoPosition } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";

const D = TEXTS.designs;
const P = TEXTS.preferences.fields;

const COLORS = ["accent", "surface", "text", "line"] as const;
const SWITCHES = ["showLogo", "showQr", "showQrLogo", "showSignature", "showDuzp"] as const;

export function AppearanceSection({
  value,
  designs,
  invalid,
  onChange,
}: {
  value: Appearance;
  designs: DesignChoice[];
  invalid: ReadonlySet<string>;
  onChange: (patch: Partial<Appearance>) => void;
}) {
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-lg">{TEXTS.invoices.form.appearance}</summary>
      <div className="mt-4 flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="field-designId">{D.pick}</Label>
            <NativeSelect
              id="field-designId"
              value={value.designId}
              onChange={(event) => onChange({ designId: event.target.value })}
            >
              {designs.map((design) => (
                <option key={design.id} value={design.id}>
                  {design.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="field-logoPosition">{D.logoPosition}</Label>
            <NativeSelect
              id="field-logoPosition"
              value={value.logoPosition}
              onChange={(event) => onChange({ logoPosition: event.target.value as LogoPosition })}
            >
              {LOGO_POSITIONS.map((position) => (
                <option key={position} value={position}>
                  {D.logoPositions[position]}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{D.colors}</legend>
          <div className="grid gap-4 sm:grid-cols-4">
            {COLORS.map((color) => (
              <div key={color} className="flex min-w-0 flex-col gap-2">
                <Label htmlFor={`field-color-${color}`}>{D.color[color]}</Label>
                <Input
                  id={`field-color-${color}`}
                  maxLength={7}
                  placeholder="#rrggbb"
                  aria-invalid={invalid.has(`field-color-${color}`) || undefined}
                  value={value.colors[color]}
                  onChange={(event) =>
                    onChange({ colors: { ...value.colors, [color]: event.target.value } })
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{D.colorsHint}</p>
        </fieldset>
        <div className="flex flex-col gap-2">
          {SWITCHES.map((name) => (
            <label key={name} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value[name]}
                onChange={(event) => onChange({ [name]: event.target.checked })}
              />
              {P[name]}
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}
