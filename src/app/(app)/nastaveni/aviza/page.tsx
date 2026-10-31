import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { BankGuide } from "@/components/settings/bank-guide";
import { BankMailboxForm } from "@/components/settings/bank-mailbox-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { getBankMailbox } from "@/server/services/bank-mailbox";

export const metadata: Metadata = { title: `${TEXTS.bankMailbox.title} | ${TEXTS.appName}` };

async function BankMailboxContent() {
  const { user } = await requireSession();
  return <BankMailboxForm settings={getBankMailbox(user.id)} />;
}

export default function BankMailboxPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.bankMailbox.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.bankMailbox.intro}</p>
      <BankGuide />
      <Suspense fallback={<PageLoading />}>
        <BankMailboxContent />
      </Suspense>
    </>
  );
}
