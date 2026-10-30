import type { ComponentType } from "react";
import type { InvoiceView } from "../view";

// Kept apart from the application's UI tokens: a document looks the same whatever the UI theme is.
export type DesignTokens = {
  colors: { accent: string; surface: string; text: string; line: string };
  fonts: { body: string; heading: string; mono: string };
  sizes: { base: number; small: number; heading: number; title: number };
  spacing: { page: number; section: number; cell: number };
  lineHeight: number;
  radius: number;
  lineWidth: number;
  mutedOpacity: number;
  watermarkOpacity: number;
};

export type InvoiceDesign = {
  id: string;
  name: string;
  tokens: DesignTokens;
  Page: ComponentType<{ view: InvoiceView }>;
};
