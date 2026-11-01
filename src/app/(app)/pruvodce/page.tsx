import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Onboarding } from "@/components/settings/onboarding";
import { EMPTY_SUPPLIER } from "@/components/settings/supplier-form";
import { parseStep, type OnboardingStep } from "@/lib/onboarding";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { designChoices } from "@/server/pdf/designs";
import { listBankAccounts } from "@/server/services/bank-accounts";
import { listSeries } from "@/server/services/number-series";
import { getPreferences, isOnboarded } from "@/server/services/preferences";
import { getSupplier, missingSupplierFields } from "@/server/services/supplier";

export const metadata: Metadata = { title: `${TEXTS.onboarding.title} | ${TEXTS.appName}` };

// Resuming picks the first step whose data is still missing, so a reload never loses progress.
function resumeStep(ownerId: string, hasLogo: boolean): OnboardingStep {
  if (missingSupplierFields(ownerId).length > 0) return "supplier";
  if (listBankAccounts(ownerId).length === 0) return "account";
  if (!hasLogo) return "logo";
  return "look";
}

async function OnboardingContent({ params }: { params: Promise<{ krok?: string | string[] }> }) {
  const { krok } = await params;
  const { user } = await requireSession();
  if (isOnboarded(user.id)) redirect("/");
  const profile = getSupplier(user.id);
  const preferences = getPreferences(user.id);
  const step = parseStep(krok) ?? resumeStep(user.id, Boolean(profile?.logoFileId));
  return (
    <Onboarding
      step={step}
      supplier={
        profile
          ? {
              name: profile.name,
              street: profile.street,
              city: profile.city,
              zip: profile.zip,
              country: profile.country,
              ico: profile.ico,
              dic: profile.dic,
              email: profile.email,
              phone: profile.phone,
              web: profile.web,
              registryNote: profile.registryNote,
              contactPerson: profile.contactPerson,
              vatIdentified: profile.vatIdentified,
              footerText: profile.footerText,
              notVatPayerCs: profile.notVatPayerCs,
              notVatPayerEn: profile.notVatPayerEn,
              reverseChargeCs: profile.reverseChargeCs,
              reverseChargeEn: profile.reverseChargeEn,
            }
          : EMPTY_SUPPLIER
      }
      logoFileId={profile?.logoFileId ?? null}
      series={listSeries(user.id)
        .filter((row) => row.isDefault)
        .map(({ id, name, template }) => ({ id, name, template }))}
      language={preferences.language}
      designId={preferences.designId}
      designs={designChoices()}
    />
  );
}

export default function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ krok?: string | string[] }>;
}) {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.onboarding.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.onboarding.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <OnboardingContent params={searchParams} />
      </Suspense>
    </>
  );
}
