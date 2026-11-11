import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AssistantConsent } from "@/components/auth/assistant-consent";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TEXTS } from "@/lib/texts";
import { getCurrentSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { consentPage, consentRequest } from "@/server/mcp/consent-info";

const C = TEXTS.mcp.consent;
const D = TEXTS.mcp.disabled;

export const metadata: Metadata = { title: C.pageTitle, robots: { index: false } };

type SearchParams = Awaited<PageProps<"/pristup-asistenta">["searchParams"]>;

// The provider signs the whole query; the signature does not depend on the order of parameters.
function toQuery(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of [value ?? []].flat()) query.append(key, item);
  }
  return query.toString();
}

async function ConsentContent({
  searchParams,
}: Pick<PageProps<"/pristup-asistenta">, "searchParams">) {
  const oauthQuery = toQuery(await searchParams);
  const session = await getCurrentSession();
  // Without a session the login page takes the signed query and comes back here (MCP-003).
  if (!session) {
    const request = await consentRequest(db, env, oauthQuery);
    redirect(request ? `/prihlaseni?${oauthQuery}` : "/prihlaseni");
  }
  const page = await consentPage(db, env, oauthQuery, session.user.id);
  if (page.kind === "invalid") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{C.invalidTitle}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{C.invalid}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }
  // Access off: the authorization ends here, with no consent (MCP-006).
  if (page.kind === "disabled") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{D.title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p>{D.body}</p>
          <p className="text-muted-foreground">{D.retry}</p>
          <Link
            href="/nastaveni/asistenti"
            className="text-primary underline-offset-4 hover:underline"
          >
            {D.link}
          </Link>
        </CardContent>
      </Card>
    );
  }
  const { request } = page;
  const capabilities = page.capabilities.map((capability) => C.capabilities[capability]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {/* Client-chosen text, rendered as text only (MCP-005). */}
          <h1 className="break-words">{C.title(request.name)}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <AssistantConsent
          host={request.host}
          capabilities={capabilities}
          oauthQuery={request.oauthQuery}
        />
      </CardContent>
    </Card>
  );
}

export default function AssistantAccessPage({ searchParams }: PageProps<"/pristup-asistenta">) {
  return (
    <Suspense>
      <ConsentContent searchParams={searchParams} />
    </Suspense>
  );
}
