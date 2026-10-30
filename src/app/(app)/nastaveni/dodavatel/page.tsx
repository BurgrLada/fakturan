import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { SupplierForm } from "@/components/settings/supplier-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getSupplier, missingSupplierFields } from "@/server/services/supplier";

export const metadata: Metadata = { title: `${TEXTS.supplier.title} | ${TEXTS.appName}` };

async function SupplierContent() {
  const { user } = await requireSession();
  const profile = getSupplier(user.id);
  const missing = missingSupplierFields(user.id);
  return (
    <>
      {missing.length > 0 && (
        <Alert>
          <AlertDescription>
            {TEXTS.supplier.missing} {missing.join(", ")}.
          </AlertDescription>
        </Alert>
      )}
      <SupplierForm
        initial={
          profile && {
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
          }
        }
        images={{
          logo: profile?.logoFileId ?? null,
          qr_logo: profile?.qrLogoFileId ?? null,
          signature: profile?.signatureFileId ?? null,
        }}
      />
    </>
  );
}

export default function SupplierPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.supplier.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.supplier.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <SupplierContent />
      </Suspense>
    </>
  );
}
