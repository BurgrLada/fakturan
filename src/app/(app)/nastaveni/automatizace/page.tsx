import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AutomationPanel } from "@/components/settings/automation-panel";
import { ReminderReview, ReminderRules } from "@/components/settings/reminder-rules";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { automationImpact, getAutomation } from "@/server/services/automation";
import { getPreferences } from "@/server/services/preferences";
import { listReminderRules, remindersForReview } from "@/server/services/reminders";

export const metadata: Metadata = { title: `${TEXTS.automation.title} | ${TEXTS.appName}` };

async function AutomationContent() {
  const { user } = await requireSession();
  const today = calendarDateInPrague(clock.now());
  return (
    <>
      <AutomationPanel settings={getAutomation(user.id)} impact={automationImpact(user.id)} />
      <ReminderRules rules={listReminderRules(user.id)} />
      <ReminderReview
        rows={remindersForReview(user.id, today)}
        dateFormat={getPreferences(user.id).dateFormat}
      />
    </>
  );
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
