import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { RecurringForm } from "@/components/recurring/recurring-form";
import { buttonVariants } from "@/components/ui/button";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { designChoices } from "@/server/pdf/designs";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { getAutomation } from "@/server/services/automation";
import { newDraftDefaults } from "@/server/services/invoices";
import { getPreferences } from "@/server/services/preferences";
import { formChoices } from "../../faktury/form-data";

const T = TEXTS.recurring;

export const metadata: Metadata = { title: `${T.newTitle} | ${TEXTS.appName}` };

async function NewPlan() {
  const { user } = await requireSession();
  const defaults = newDraftDefaults(user.id, null);
  const today = calendarDateInPrague(clock.now());
  const choices = formChoices(user.id, null, "invoice");
  return (
    <RecurringForm
      planId={null}
      status={null}
      accounts={choices.accounts}
      units={choices.units}
      defaultUnit={choices.defaultUnit}
      recurringSend={getAutomation(user.id).recurringSend}
      designs={designChoices()}
      initial={{
        name: "",
        customerId: null,
        customerName: "",
        document: {
          type: "invoice",
          bankAccountId: defaults.bankAccountId ?? null,
          dueDays: getPreferences(user.id).dueDays,
          language: defaults.language,
          currency: defaults.currency,
          paymentMethod: defaults.paymentMethod,
          orderRef: "",
          reference: "",
          textBefore: defaults.textBefore,
          textAfter: defaults.textAfter,
          note: defaults.note,
          discountKind: "none",
          discountValue: 0,
          rounding: defaults.rounding,
          appearance: defaults.appearance,
          lines: [],
        },
        frequency: "monthly",
        every: 1,
        issueRule: "day",
        issueDay: Number(today.slice(8)),
        startsOn: today,
        endsOn: null,
        maxCount: null,
        periodOffset: 0,
        mode: "draft",
        notifyDaysBefore: null,
        sendConfirmed: false,
      }}
    />
  );
}

export default function NewRecurringPage() {
  return (
    <>
      <Link
        href="/pravidelne"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.newTitle}</h1>
      <Suspense fallback={<PageLoading />}>
        <NewPlan />
      </Suspense>
    </>
  );
}
