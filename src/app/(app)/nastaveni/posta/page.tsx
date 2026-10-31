import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { MailSettingsForm } from "@/components/settings/mail-settings-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getMailSettings, mailAvailability } from "@/server/services/mail-settings";

export const metadata: Metadata = { title: `${TEXTS.mailSettings.title} | ${TEXTS.appName}` };

async function MailContent() {
  const { user } = await requireSession();
  return (
    <MailSettingsForm
      settings={getMailSettings(user.id)}
      availability={mailAvailability(user.id)}
    />
  );
}

export default function MailSettingsPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.mailSettings.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.mailSettings.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <MailContent />
      </Suspense>
    </>
  );
}
