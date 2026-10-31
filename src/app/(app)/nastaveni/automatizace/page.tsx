import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AutomationPanel } from "@/components/settings/automation-panel";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { automationImpact, getAutomation } from "@/server/services/automation";

export const metadata: Metadata = { title: `${TEXTS.automation.title} | ${TEXTS.appName}` };

async function AutomationContent() {
  const { user } = await requireSession();
  return <AutomationPanel settings={getAutomation(user.id)} impact={automationImpact(user.id)} />;
}

export default function AutomationPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.automation.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.automation.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <AutomationContent />
      </Suspense>
    </>
  );
}
