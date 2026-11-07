import type { Metadata } from "next";
import { Suspense } from "react";
import { HelpFaq } from "@/components/help/help-faq";
import { HelpIndex } from "@/components/help/help-index";
import { HashScroll } from "@/components/help/hash-scroll";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";

const H = TEXTS.help;

export const metadata: Metadata = { title: `${H.title} | ${TEXTS.appName}` };

async function HelpContent() {
  await requireSession();
  return (
    <>
      <HelpIndex />
      <HelpFaq />
      <HashScroll />
    </>
  );
}

export default function HelpPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{H.title}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">{H.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <HelpContent />
      </Suspense>
    </>
  );
}
