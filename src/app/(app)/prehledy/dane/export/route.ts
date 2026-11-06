import type { NextRequest } from "next/server";
import { contentDisposition } from "@/lib/content-disposition";
import { calendarDateInPrague } from "@/lib/number-format";
import { parseTaxFilter } from "@/lib/report-filter";
import { env } from "@/server/env";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { RateLimitError } from "@/server/services/access";
import { exportTaxOverview, TAX_EXPORT_FORMATS } from "@/server/services/tax-report";

// POST with an origin check: the export is logged and rate limited, so a cross-site page must not trigger it.
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return new Response(null, { status: 403 });
  if (!(await getCurrentSession())) return new Response(null, { status: 401 });
  const form = await request.formData().catch(() => new FormData());
  const fields = Object.fromEntries(
    [...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const format = TAX_EXPORT_FORMATS.find((value) => value === fields.format) ?? "csv";
  const today = calendarDateInPrague(clock.now());
  try {
    const file = await exportTaxOverview(
      await actorFromRequest(),
      { ...parseTaxFilter(fields, today), today },
      format,
    );
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
    throw error;
  }
}
