import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NewPasswordForm, RequestResetForm } from "@/components/auth/reset-forms";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isInstanceMailConfigured } from "@/server/mail/instance";

export const metadata: Metadata = { title: "Obnova hesla | Fakturan" };

async function ResetContent({ searchParams }: Pick<PageProps<"/reset-hesla">, "searchParams">) {
  const { token, error } = await searchParams;
  if (typeof token === "string") return <NewPasswordForm token={token} />;
  if (!isInstanceMailConfigured()) {
    return (
      <Alert>
        <AlertDescription>
          Tato instance nemá nastavené odesílání e-mailů. Obraťte se na jejího správce.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>Odkaz už neplatí, požádejte o nový.</AlertDescription>
        </Alert>
      )}
      <RequestResetForm />
    </>
  );
}

export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-hesla">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>Obnova hesla</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Suspense>
          <ResetContent searchParams={searchParams} />
        </Suspense>
        <p className="text-sm text-muted-foreground">
          <Link href="/prihlaseni" className="underline">
            Zpět na přihlášení
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
