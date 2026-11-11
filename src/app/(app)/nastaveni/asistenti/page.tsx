import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AssistantConnections } from "@/components/settings/assistant-connections";
import { AssistantsForm } from "@/components/settings/assistants-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { isMcpAvailable, mcpResource } from "@/server/mcp/availability";
import { listMcpConnections } from "@/server/services/mcp-connections";
import { getMcpSettings } from "@/server/services/mcp-settings";

const T = TEXTS.mcp.settings;

export const metadata: Metadata = { title: T.pageTitle };

const day = new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeZone: "Europe/Prague" });

async function AssistantsContent() {
  await connection();
  if (!isMcpAvailable(env)) notFound();
  const { user } = await requireSession();
  const resource = mcpResource(env);
  const connections = listMcpConnections(user.id).map((c) => ({
    clientId: c.clientId,
    name: c.name,
    host: c.host,
    connectedAt: day.format(c.connectedAt),
    lastUsedAt: c.lastUsedAt ? day.format(c.lastUsedAt) : null,
  }));
  const hostname = new URL(resource).hostname;
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  return (
    <>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <AssistantsForm settings={getMcpSettings(user.id)} address={resource} local={local} />
      <AssistantConnections connections={connections} />
    </>
  );
}

export default function AssistantsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AssistantsContent />
    </Suspense>
  );
}
