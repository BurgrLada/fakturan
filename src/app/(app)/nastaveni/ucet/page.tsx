import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { DeleteAccountForm } from "@/components/account/delete-account-form";
import { SessionList } from "@/components/account/session-list";
import { LinkedAccounts } from "@/components/account/linked-accounts";
import { EntityHistory } from "@/components/audit/entity-history";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import { auth } from "@/server/auth";
import { enabledProviders } from "@/server/auth/providers";
import { requireSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { hasPassword } from "@/server/services/users";

export const metadata: Metadata = { title: `${TEXTS.account.title} | ${TEXTS.appName}` };

async function AccountContent({
  searchParams,
}: Pick<PageProps<"/nastaveni/ucet">, "searchParams">) {
  const { user, session } = await requireSession();
  const { chyba } = await searchParams;
  const requestHeaders = await headers();
  const accounts = await auth.api.listUserAccounts({ headers: requestHeaders });
  const sessions = (await auth.api.listSessions({ headers: requestHeaders })).map((row) => ({
    id: row.id,
    current: row.id === session.id,
    device: row.userAgent || TEXTS.sessions.unknownDevice,
    ip: row.ipAddress ?? null,
    createdAt: formatDateTime(row.createdAt),
    expiresAt: formatDateTime(row.expiresAt),
  }));
  return (
    <>
      {chyba === "propojeni" && (
        <Alert variant="destructive">
          <AlertDescription>{TEXTS.linked.linkFailed}</AlertDescription>
        </Alert>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg">{TEXTS.account.profile}</h2>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted-foreground">{TEXTS.account.name}</dt>
          <dd>{user.name}</dd>
        </dl>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg">{TEXTS.account.loginMethods}</h2>
        <LinkedAccounts
          accounts={accounts.map(({ id, providerId }) => ({ id, providerId }))}
          available={enabledProviders(env)}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg">{TEXTS.sessions.title}</h2>
        <SessionList sessions={sessions} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg">{TEXTS.account.history}</h2>
        <EntityHistory entity="user" entityId={user.id} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg">{TEXTS.account.deleteTitle}</h2>
        <DeleteAccountForm hasPassword={hasPassword(user.id)} />
      </section>
    </>
  );
}

export default function AccountPage({ searchParams }: PageProps<"/nastaveni/ucet">) {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.account.title}</h1>
      <Suspense fallback={<PageLoading />}>
        <AccountContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
