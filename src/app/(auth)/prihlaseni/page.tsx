import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { SocialButtons } from "@/components/auth/social-buttons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TEXTS } from "@/lib/texts";
import { enabledProviders } from "@/server/auth/providers";
import { isSignupOpen } from "@/server/auth/signup-guard";
import { db } from "@/server/db";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Přihlášení | Fakturan" };

const D = TEXTS.demo;

// The demo login is public by design (OPS-007): the visitor needs it to try the app.
function DemoCredentials({ email, password }: { email: string; password: string }) {
  return (
    <Alert>
      <AlertDescription className="flex flex-col gap-1">
        <strong>{D.login}</strong>
        <span>{D.loginHint}</span>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3">
          <dt>{D.email}</dt>
          <dd className="font-mono">{email}</dd>
          <dt>{D.password}</dt>
          <dd className="font-mono">{password}</dd>
        </dl>
      </AlertDescription>
    </Alert>
  );
}

async function LoginContent({ searchParams }: Pick<PageProps<"/prihlaseni">, "searchParams">) {
  const { chyba } = await searchParams;
  return (
    <>
      {chyba === "pozvanka" && (
        <Alert variant="destructive">
          <AlertDescription>Přístup je jen na pozvánku</AlertDescription>
        </Alert>
      )}
      {env.DEMO_MODE && env.DEMO_EMAIL && env.DEMO_PASSWORD && (
        <DemoCredentials email={env.DEMO_EMAIL} password={env.DEMO_PASSWORD} />
      )}
      <LoginForm />
      <SocialButtons providers={enabledProviders(env)} />
      {!env.DEMO_MODE && isSignupOpen(db) && (
        <p className="text-sm text-muted-foreground">
          <Link href="/registrace" className="underline">
            Vytvořit první účet
          </Link>
        </p>
      )}
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
