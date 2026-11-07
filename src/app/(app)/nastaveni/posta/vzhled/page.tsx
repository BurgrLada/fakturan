import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { MailLookForm } from "@/components/settings/mail-look-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getMailLook } from "@/server/services/mail-look";

const T = TEXTS.mailLook;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function LookContent() {
  const { user } = await requireSession();
  return <MailLookForm look={getMailLook(user.id)} />;
}

export default function MailLookPage() {
  return (
    <>
      <Link href="/nastaveni/posta" className="text-sm text-muted-foreground underline">
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <LookContent />
      </Suspense>
    </>
  );
}
