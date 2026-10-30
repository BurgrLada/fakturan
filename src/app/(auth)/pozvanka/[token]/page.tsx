import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { inspectInvitation } from "@/server/services/invitations";
import { acceptInvitationAction } from "./actions";

export const metadata: Metadata = { title: "Pozvánka | Fakturan", robots: { index: false } };

const REFUSALS = {
  used: "Tato pozvánka už byla použita. Pokud máte účet, přihlaste se.",
  expired: "Platnost pozvánky vypršela. Požádejte správce o novou.",
  revoked: "Tuto pozvánku správce zrušil. Pokud ji čekáte, ozvěte se mu.",
  unknown: "Tento odkaz neplatí. Zkontrolujte ho, nebo požádejte správce o novou pozvánku.",
};

async function InvitationContent({ params }: Pick<PageProps<"/pozvanka/[token]">, "params">) {
  const { token } = await params;
  const check = inspectInvitation(token);
  if (check.status !== "valid") {
    return (
      <>
        <Alert variant="destructive">
          <AlertDescription>{REFUSALS[check.status]}</AlertDescription>
        </Alert>
        <p className="text-sm text-muted-foreground">
          <Link href="/prihlaseni" className="underline">
            Přejít na přihlášení
          </Link>
        </p>
      </>
    );
  }
  return (
    <form action={acceptInvitationAction.bind(null, token)} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Pozvánka pro {check.email}. Účet si založíte heslem, nebo přes poskytovatele přihlášení.
      </p>
      <Button type="submit">Pokračovat k registraci</Button>
    </form>
  );
}

export default function InvitationPage({ params }: PageProps<"/pozvanka/[token]">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>Pozvánka do Fakturanu</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Suspense>
          <InvitationContent params={params} />
        </Suspense>
      </CardContent>
    </Card>
  );
}
