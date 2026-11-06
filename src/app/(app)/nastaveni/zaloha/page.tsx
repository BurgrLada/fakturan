import type { Metadata } from "next";
import { Suspense } from "react";
import { BackupPanel } from "@/components/backup/backup-panel";
import { RestorePanel } from "@/components/backup/restore-panel";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listBackups } from "@/server/services/account-backup";
import { listAuditArchives } from "@/server/services/account-restore";
import { formatDateTime } from "@/lib/format";
import { latestRestore } from "@/server/services/exports";

const T = TEXTS.backup;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

function AuditArchives({ ownerId }: { ownerId: string }) {
  const archives = listAuditArchives(ownerId);
  if (archives.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">{T.auditArchives}</h2>
      <ul className="divide-y rounded-lg border text-sm">
        {archives.map((archive) => (
          <li key={archive.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <span>{formatDateTime(archive.createdAt)}</span>
            <a href={`/soubory/${archive.id}`} className="underline underline-offset-4">
              {T.auditArchiveDownload}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function BackupContent() {
  const { user } = await requireSession();
  return (
    <>
      <BackupPanel initial={listBackups(user.id)} />
      <RestorePanel initial={latestRestore(user.id)} />
      <AuditArchives ownerId={user.id} />
    </>
  );
}

export default function BackupPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <p className="text-sm text-muted-foreground">{T.secrets}</p>
      <Suspense fallback={<PageLoading />}>
        <BackupContent />
      </Suspense>
    </>
  );
}
