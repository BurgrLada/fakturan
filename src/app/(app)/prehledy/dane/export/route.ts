import type { NextRequest } from "next/server";
import { z } from "zod";
import { contentDisposition } from "@/lib/content-disposition";
import { calendarDateInPrague } from "@/lib/number-format";
import { FIRST_TAX_YEAR, TAX_BASIS_PARAM, type TaxBasis } from "@/lib/report-filter";
import { TEXTS } from "@/lib/texts";
import { env } from "@/server/env";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { RateLimitError, ServiceError } from "@/server/services/access";
import { exportTaxOverview, TAX_EXPORT_FORMATS } from "@/server/services/tax-report";

// The form sends exactly these three fields; anything else is a request the page never makes.
function taxExportInput(today: string) {
  const bases = Object.entries(TAX_BASIS_PARAM) as [TaxBasis, string][];
  return z
    .strictObject({
      format: z.enum(TAX_EXPORT_FORMATS),
      rok: z
        .string()
        .regex(/^\d{4}$/)
        .transform(Number)
        .refine((year) => year >= FIRST_TAX_YEAR && year <= Number(today.slice(0, 4))),
      zaklad: z.enum(bases.map(([, param]) => param) as [string, ...string[]]),
    })
    .transform(({ format, rok, zaklad }) => ({
      format,
      year: rok,
      basis: bases.find(([, param]) => param === zaklad)![0],
    }));
}

// POST with an origin check: the export is logged and rate limited, so a cross-site page must not trigger it.
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return new Response(null, { status: 403 });
  if (!(await getCurrentSession())) return new Response(null, { status: 401 });
  const form = await request.formData().catch(() => new FormData());
  const entries = [...form.entries()];
  // A file in any field is a request the page never sends, not one to read around.
  if (entries.some(([, value]) => typeof value !== "string")) {
    return new Response(TEXTS.tax.errors.invalid, { status: 400 });
  }
  const fields = Object.fromEntries(entries as [string, string][]);
  const today = calendarDateInPrague(clock.now());
  const parsed = taxExportInput(today).safeParse(fields);
  if (!parsed.success) return new Response(TEXTS.tax.errors.invalid, { status: 400 });
  const { format, ...filter } = parsed.data;
  try {
    const file = await exportTaxOverview(await actorFromRequest(), { ...filter, today }, format);
    return new Response(file.body as BodyInit, {
      headers: {
        "content-type": file.contentType,
        "content-disposition": contentDisposition("attachment", file.filename),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return new Response(error.message, { status: 429 });
    if (error instanceof ServiceError) return new Response(error.message, { status: 422 });
    throw error;
  }
}
