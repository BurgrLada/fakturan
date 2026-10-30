import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NumberSeries } from "@/components/settings/number-series";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { hasMissingDefaults, listSeries } from "@/server/services/number-series";

export const metadata: Metadata = { title: `${TEXTS.numberSeries.title} | ${TEXTS.appName}` };

async function NumberSeriesContent() {
  const { user } = await requireSession();
  const today = calendarDateInPrague(clock.now());
  const series = listSeries(user.id, today).map((row) => ({
    id: row.id,
    name: row.name,
    documentType: row.documentType,
    template: row.template,
    reset: row.reset,
    isDefault: row.isDefault,
    next: row.next,
    used: row.used,
  }));
  return <NumberSeries series={series} today={today} needsDefaults={hasMissingDefaults(user.id)} />;
}

export default function NumberSeriesPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.numberSeries.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.numberSeries.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <NumberSeriesContent />
      </Suspense>
    </>
  );
}
