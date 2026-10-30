import "server-only";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

export class InvalidFileError extends Error {}

const purifier = DOMPurify(new JSDOM("").window as unknown as Window & typeof globalThis);

function startsWith(data: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, i) => data[offset + i] === byte);
}

function rasterType(data: Buffer): ImageMime | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

function looksLikeSvg(data: Buffer): boolean {
  const head = data.subarray(0, 4096).toString("utf8").replace(/^﻿/, "");
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(
    head,
  );
}

function sanitizeSvg(source: string): Buffer {
  const clean = purifier.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "use", "image", "a", "style", "animate", "set"],
    FORBID_ATTR: ["href", "xlink:href", "style"],
    ADD_URI_SAFE_ATTR: [],
  });
  if (!/^\s*<svg[\s>]/i.test(clean)) throw new InvalidFileError("Neplatný soubor SVG");
  return Buffer.from(clean, "utf8");
}

// The type comes from the content; the name and extension are never consulted.
export function validateImage(data: Buffer): { data: Buffer; mimeType: ImageMime } {
  if (data.length === 0) throw new InvalidFileError("Soubor je prázdný");
  if (data.length > MAX_FILE_BYTES) throw new InvalidFileError("Soubor je větší než 2 MB");
  const raster = rasterType(data);
  if (raster) return { data, mimeType: raster };
  if (looksLikeSvg(data)) {
    return { data: sanitizeSvg(data.toString("utf8")), mimeType: "image/svg+xml" };
  }
  throw new InvalidFileError("Povolené jsou jen obrázky PNG, JPEG, WebP a SVG");
}
