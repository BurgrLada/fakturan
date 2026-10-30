import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { SocialButtons } from "@/components/auth/social-buttons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { enabledProviders } from "@/server/auth/providers";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Přihlášení | Fakturan" };

async function LoginContent({ searchParams }: Pick<PageProps<"/prihlaseni">, "searchParams">) {
  const { chyba, error } = await searchParams;
  const notice =
    chyba === "pozvanka"
      ? "Přístup je jen na pozvánku"
      : error
        ? "Přihlášení se nepovedlo, zkuste to prosím znovu."
        : null;
  return (
    <>
      {notice && (
        <Alert variant="destructive">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      <LoginForm />
      <SocialButtons providers={enabledProviders(env)} />
    </>
  );
}

export default function LoginPage({ searchParams }: PageProps<"/prihlaseni">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>Přihlášení</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Suspense>
          <LoginContent searchParams={searchParams} />
        </Suspense>
        <p className="text-sm text-muted-foreground">
          <Link href="/reset-hesla" className="underline">
            Zapomenuté heslo
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
