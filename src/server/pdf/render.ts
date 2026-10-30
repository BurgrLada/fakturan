import "server-only";
import { Document, renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { getDesign } from "./designs";
import { registerFonts, reloadFonts } from "./fonts";
import type { InvoiceView } from "./view";

type RenderQueue = { tail: Promise<unknown> };

// Each route gets its own copy of a bundled module, so the queue lives on the process.
const QUEUE_KEY = Symbol.for("fakturan.pdf.render-queue");
const store = globalThis as unknown as Record<symbol, RenderQueue | undefined>;
const queue = (store[QUEUE_KEY] ??= { tail: Promise.resolve() });

const RENDER_TIMEOUT_MS = 30_000;

export class RenderTimeoutError extends Error {}

function withTimeout<T>(job: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RenderTimeoutError("PDF render timed out")), timeoutMs);
  });
  // The constructor turns a synchronous throw into a rejection, so the timer is always cleared.
  const run = new Promise<T>((resolve) => resolve(job()));
  return Promise.race([run, expired]).finally(() => clearTimeout(timer));
}

// The timeout frees the queue and the caller; a hung render itself cannot be cancelled.
export function serializeRender<T>(
  job: () => Promise<T>,
  timeoutMs = RENDER_TIMEOUT_MS,
): Promise<T> {
  const result = queue.tail.then(() => withTimeout(job, timeoutMs));
  queue.tail = result.catch(() => {});
  return result;
}

export function renderInvoicePdf(view: InvoiceView): Promise<Buffer> {
  const { Page } = getDesign(view.designId);
  const metadata = view.supplier?.name || view.title;
  return serializeRender(() => {
    registerFonts();
    reloadFonts();
    return renderToBuffer(
      createElement(
        Document,
        {
          title: [view.title, view.number].filter(Boolean).join(" "),
          author: metadata,
          creator: metadata,
          producer: metadata,
          language: view.language,
        },
        createElement(Page, { view }),
      ),
    );
  });
}
