import { missingColumns, type Mapping, type MappingTarget } from "./import-mapping";
import { TEXTS } from "./texts";

export type PresetView = {
  id: string;
  name: string;
  target: MappingTarget;
  mapping: Mapping;
  builtIn: boolean;
};

// R-22: a built-in preset only for headers checked on a real export. The Fakturoid contacts
// header was read from a local export on 2026-11-06, the header line only; there is no real
// sample for Fakturoid invoices or iDoklad yet.
export const BUILTIN_PRESETS: PresetView[] = [
  {
    id: "builtin:fakturoid-kontakty",
    name: TEXTS.importing.mapping.presets.fakturoidContacts,
    target: "customers",
    builtIn: true,
    mapping: {
      target: "customers",
      columns: {
        name: "name",
        street: "street",
        city: "city",
        zip: "zip",
        country: "country",
        ico: "registration_no",
        dic: "vat_no",
        email: "email",
        phone: "phone",
        note: "private_note",
        dueDays: "due",
        currency: "currency",
      },
      dateFormat: "ymd",
      decimal: ".",
      currency: "CZK",
      source: "Fakturoid",
    },
  },
];

// The first preset whose every column the file has.
export function fittingPreset(headers: string[], presets: PresetView[]): PresetView | null {
  return presets.find((preset) => missingColumns(headers, preset.mapping).length === 0) ?? null;
}
