"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restoreVersionAction } from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.versions;

export function VersionList({
  invoiceId,
  versions,
}: {
  invoiceId: string;
  versions: { id: string; versionNo: number; createdAt: Date }[];
}) {
  if (versions.length === 0) return <p className="text-sm text-muted-foreground">{T.empty}</p>;
  return (
    <ul className="flex flex-col divide-y rounded-md border text-sm">
      {versions.map((version) => (
        <li key={version.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 p-2">
          <Link
            href={`/faktury/${invoiceId}/verze/${version.id}`}
            className="underline-offset-4 hover:underline"
          >
            {T.label(version.versionNo)}
          </Link>
          <time dateTime={version.createdAt.toISOString()} className="text-muted-foreground">
            {formatDateTime(version.createdAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}

function restoredQuery(reply: { resendSuggested: boolean; balanceWarning: string }): string {
  const params = new URLSearchParams({ obnoveno: "1" });
  if (reply.resendSuggested) params.set("odeslat", "1");
  if (reply.balanceWarning !== "none") params.set("zustatek", reply.balanceWarning);
  return `?${params}`;
}

export function RestoreVersion({ invoiceId, versionId }: { invoiceId: string; versionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function restore() {
    setError(null);
    startTransition(async () => {
      try {
        const reply = await restoreVersionAction({ id: versionId });
        if (reply.ok) router.push(`/faktury/${invoiceId}${restoredQuery(reply)}`);
        else setError(reply.error);
      } catch {
        setError(T.failed);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="outline" disabled={pending} onClick={restore}>
          {T.restore}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" role="status">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
