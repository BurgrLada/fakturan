import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getPreferences } from "@/server/services/preferences";

export const metadata: Metadata = { title: `${TEXTS.preferences.title} | ${TEXTS.appName}` };

async function PreferencesContent() {
  const { user } = await requireSession();
  return <PreferencesForm initial={getPreferences(user.id)} />;
}

export default function PreferencesPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.preferences.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.preferences.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <PreferencesContent />
      </Suspense>
    </>
  );
}
