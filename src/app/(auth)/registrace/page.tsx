import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { RegisterForm } from "@/components/auth/register-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { INVITE_COOKIE, isSignupOpen } from "@/server/auth/signup-guard";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Registrace | Fakturan" };

async function RegisterContent() {
  const token = (await cookies()).get(INVITE_COOKIE)?.value;
  if (isSignupOpen(db, token)) return <RegisterForm />;
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
