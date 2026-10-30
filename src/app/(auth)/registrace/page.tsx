import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { RegisterForm } from "@/components/auth/register-form";
import { SocialButtons } from "@/components/auth/social-buttons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { enabledProviders } from "@/server/auth/providers";
import { INVITE_COOKIE, isSignupOpen } from "@/server/auth/signup-guard";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { inspectInvitation } from "@/server/services/invitations";

export const metadata: Metadata = { title: "Registrace | Fakturan" };

async function RegisterContent() {
  const token = (await cookies()).get(INVITE_COOKIE)?.value;
  if (isSignupOpen(db, token)) {
    const invite = token ? inspectInvitation(token) : null;
    return (
      <>
        <RegisterForm invitedEmail={invite?.status === "valid" ? invite.email : undefined} />
        <SocialButtons providers={enabledProviders(env)} />
      </>
    );
  }
  return (
    <Alert>
      <AlertDescription>Přístup je jen na pozvánku</AlertDescription>
    </Alert>
  );
}

export default function RegisterPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>Registrace</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Suspense>
          <RegisterContent />
        </Suspense>
        <p className="text-sm text-muted-foreground">
          <Link href="/prihlaseni" className="underline">
            Už mám účet
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
