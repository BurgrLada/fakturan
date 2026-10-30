import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Canvas } from "@napi-rs/canvas";
import jsQR from "jsqr";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const MAX_DIFF_RATIO = 0.001;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfTask = ReturnType<PdfJs["getDocument"]>;

let pdfjs: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

async function open(pdf: Buffer): Promise<PdfTask> {
  const lib = await loadPdfJs();
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const url = (dir: string) => `${pathToFileURL(join(root, dir)).href}/`;
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  return lib.getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl: url("standard_fonts"),
    cMapUrl: url("cmaps"),
    iccUrl: url("iccs"),
    wasmUrl: url("wasm"),
    useSystemFonts: false,
    verbosity: 0,
  });
}

export async function pdfText(pdf: Buffer): Promise<string[]> {
  const task = await open(pdf);
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const content = await (await doc.getPage(number)).getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join(""),
      );
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

export type PdfTextItem = { text: string; top: number; bottom: number };

// PDF coordinates: y grows upwards from the bottom of the page.
export async function pdfTextItems(pdf: Buffer, page: number): Promise<PdfTextItem[]> {
  const task = await open(pdf);
  try {
    const doc = await task.promise;
    const content = await (await doc.getPage(page)).getTextContent();
    return content.items.flatMap((item) =>
      "str" in item && item.str.trim()
        ? [
            {
              text: item.str,
              top: item.transform[5] + item.height,
              bottom: item.transform[5],
            },
          ]
        : [],
    );
  } finally {
    await task.destroy();
  }
}

export async function pdfPagePng(pdf: Buffer, page: number, scale = 2): Promise<Buffer> {
  const task = await open(pdf);
  try {
    const doc = await task.promise;
    const target = await doc.getPage(page);
    const viewport = target.getViewport({ scale });
    const factory = doc.canvasFactory as {
      create(
        width: number,
        height: number,
      ): { canvas: Canvas & HTMLCanvasElement; context: CanvasRenderingContext2D };
    };
    const { canvas, context } = factory.create(viewport.width, viewport.height);
    await target.render({ canvas, canvasContext: context, viewport }).promise;
    return Buffer.from(canvas.toBuffer("image/png"));
  } finally {
    await task.destroy();
  }
}

export function decodeQr(png: Buffer): string | null {
  const { data, width, height } = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(data), width, height)?.data ?? null;
}

export function expectMatchesSnapshot(png: Buffer, name: string): void {
  const dir = process.env.PDF_SNAPSHOT_DIR ?? join(process.cwd(), "tests/pdf-snapshots");
  const path = join(dir, `${name}.png`);
  if (process.env.UPDATE_PDF_SNAPSHOTS === "1" || !existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, png);
    if (process.env.UPDATE_PDF_SNAPSHOTS !== "1") {
      throw new Error(
        `Reference ${name}.png neexistovala, byla vytvořena; zkontroluj ji a spusť znovu`,
      );
    }
    return;
  }
  const expected = PNG.sync.read(readFileSync(path));
  const actual = PNG.sync.read(png);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new Error(
      `Snapshot ${name}: rozměry ${actual.width}x${actual.height} místo ${expected.width}x${expected.height}`,
    );
  }
  const diff = pixelmatch(expected.data, actual.data, null, actual.width, actual.height);
  const ratio = diff / (actual.width * actual.height);
  if (ratio > MAX_DIFF_RATIO) {
    throw new Error(`Snapshot ${name}: ${(ratio * 100).toFixed(3)} % pixelů se liší (práh 0,1 %)`);
  }
}
