import type { Metadata } from "next";
import { Suspense } from "react";
import { BackupPanel } from "@/components/backup/backup-panel";
import { RestorePanel } from "@/components/backup/restore-panel";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listBackups } from "@/server/services/account-backup";
import { latestRestore } from "@/server/services/exports";

const T = TEXTS.backup;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function BackupContent() {
  const { user } = await requireSession();
  return (
    <>
      <BackupPanel initial={listBackups(user.id)} />
      <RestorePanel initial={latestRestore(user.id)} />
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
