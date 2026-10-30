import "server-only";
import { cisty } from "./cisty";
import type { InvoiceDesign } from "./types";

export const DESIGNS: readonly InvoiceDesign[] = [cisty];

export function isDesignId(id: string): boolean {
  return DESIGNS.some((design) => design.id === id);
}

export function getDesign(id: string): InvoiceDesign {
  return DESIGNS.find((design) => design.id === id) ?? cisty;
}
