import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { EmailTemplateForm } from "@/components/settings/email-template-form";
import { RECEIPT_VARIABLE_NAMES } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listEmailTemplates } from "@/server/services/email-templates";

const T = TEXTS.emailTemplates;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function TemplatesContent() {
  const { user } = await requireSession();
  return (
    <EmailTemplateForm templates={listEmailTemplates(user.id)} variables={RECEIPT_VARIABLE_NAMES} />
  );
}

export default function EmailTemplatesPage() {
  return (
    <>
      <Link href="/nastaveni/posta" className="text-sm text-muted-foreground underline">
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <TemplatesContent />
      </Suspense>
    </>
  );
}
