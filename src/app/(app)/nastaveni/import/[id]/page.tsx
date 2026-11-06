import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ColumnMapper } from "@/components/import/column-mapper";
import { ImportProgress } from "@/components/import/import-progress";
import { PageLoading } from "@/components/page-loading";
import { defaultMapping, mappingSchema } from "@/lib/import-mapping";
import { fittingPreset } from "@/lib/import-presets";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getPreview } from "@/server/services/import-batch";
import { getSample } from "@/server/services/import-tabular";
import { listPresets } from "@/server/services/mapping-presets";

const T = TEXTS.importing;

export const metadata: Metadata = { title: `${T.preview.title} | ${TEXTS.appName}` };

async function BatchContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  const found = getPreview(user.id, id);
  if (!found) notFound();
  const { batch } = found;
  const sample = batch.status === "mapping" ? getSample(user.id, id) : null;
  if (sample) {
    const presets = listPresets(user.id);
    const earlier = mappingSchema.safeParse(batch.mapping);
    const initial = earlier.success
      ? earlier.data
      : (fittingPreset(sample.headers, presets)?.mapping ??
        defaultMapping("customers", sample.headers));
    return (
      <ColumnMapper
        key={batch.revision}
        batchId={id}
        revision={batch.revision}
        sample={sample}
        presets={presets}
        initial={initial}
      />
    );
  }
  const { kind, target, status, progress, revision, error, summary } = batch;
  return (
    <ImportProgress
      key={batch.revision}
      initial={{
        batch: { id, kind, target, status, progress, revision, error, summary },
        rows: found.rows,
      }}
    />
  );
}

export default function ImportBatchPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.preview.title}</h1>
      <Suspense fallback={<PageLoading />}>
        <BatchContent params={params} />
      </Suspense>
    </>
  );
}
