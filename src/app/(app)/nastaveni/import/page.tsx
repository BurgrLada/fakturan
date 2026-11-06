import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DiscardBatch } from "@/components/import/discard-batch";
import { UploadZone } from "@/components/import/upload-zone";
import { PageLoading } from "@/components/page-loading";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listBatches } from "@/server/services/import-batch";

const T = TEXTS.importing;
const DISCARDABLE = new Set(["uploading", "mapping", "ready"]);

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function BatchList() {
  const { user } = await requireSession();
  const batches = listBatches(user.id);
  if (batches.length === 0) return <p className="text-sm text-muted-foreground">{T.list.empty}</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {batches.map((batch) => (
        <li key={batch.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <span>
            {formatDateTime(batch.createdAt)} · {T.statuses[batch.status]}
            {batch.summary?.documents !== undefined &&
              ` · ${T.list.documents}: ${batch.summary.documents}`}
          </span>
          <span className="flex items-center gap-2">
            {DISCARDABLE.has(batch.status) && <DiscardBatch batchId={batch.id} />}
            <Link href={`/nastaveni/import/${batch.id}`} className="underline underline-offset-4">
              {T.list.open}
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function ImportPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <UploadZone />
      <h2 className="text-lg font-medium">{T.list.title}</h2>
      <Suspense fallback={<PageLoading />}>
        <BatchList />
      </Suspense>
    </>
  );
}
