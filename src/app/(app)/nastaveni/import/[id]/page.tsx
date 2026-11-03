import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ImportProgress } from "@/components/import/import-progress";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getPreview } from "@/server/services/import-batch";

const T = TEXTS.importing;

export const metadata: Metadata = { title: `${T.preview.title} | ${TEXTS.appName}` };

async function BatchContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  const found = getPreview(user.id, id);
  if (!found) notFound();
  const { status, progress, revision, error, summary } = found.batch;
  return (
    <ImportProgress
      initial={{ batch: { id, status, progress, revision, error, summary }, rows: found.rows }}
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
