import "server-only";
import { barevnyPas } from "./barevny-pas";
import { blok } from "./blok";
import { bocniPruh } from "./bocni-pruh";
import { cisty } from "./cisty";
import { editorial } from "./editorial";
import { geometric } from "./geometric";
import { klasik } from "./klasik";
import { kompaktni } from "./kompaktni";
import { kontrast } from "./kontrast";
import { minimal } from "./minimal";
import { mono } from "./mono";
import { tabulkovy } from "./tabulkovy";
import type { InvoiceDesign } from "./types";

export const DESIGNS: readonly InvoiceDesign[] = [
  cisty,
  editorial,
  barevnyPas,
  tabulkovy,
  blok,
  minimal,
  mono,
  klasik,
  geometric,
  kontrast,
  bocniPruh,
  kompaktni,
];

export function isDesignId(id: string): boolean {
  return DESIGNS.some((design) => design.id === id);
}

export function getDesign(id: string): InvoiceDesign {
  return DESIGNS.find((design) => design.id === id) ?? cisty;
}

export const designChoices = () => DESIGNS.map(({ id, name }) => ({ id, name }));
