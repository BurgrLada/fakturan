import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { BankAccounts } from "@/components/settings/bank-accounts";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listBankAccounts } from "@/server/services/bank-accounts";

export const metadata: Metadata = { title: `${TEXTS.bankAccounts.title} | ${TEXTS.appName}` };

async function BankAccountsContent() {
  const { user } = await requireSession();
  const accounts = listBankAccounts(user.id).map((row) => ({
    id: row.id,
    name: row.name,
    currency: row.currency,
    number: row.number,
    bankCode: row.bankCode,
    iban: row.iban,
    swift: row.swift,
    isDefault: row.isDefault,
    hidden: row.hidden,
  }));
  return <BankAccounts accounts={accounts} />;
}

export default function BankAccountsPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.bankAccounts.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.bankAccounts.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <BankAccountsContent />
      </Suspense>
    </>
  );
}
