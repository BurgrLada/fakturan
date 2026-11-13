import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import {
  AssistantCallLog,
  CALL_LOG_PARAMS,
  type CallLogFilter,
} from "@/components/settings/assistant-call-log";
import { AssistantConnections } from "@/components/settings/assistant-connections";
import { AssistantsForm } from "@/components/settings/assistants-form";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { isMcpAvailable, mcpResource } from "@/server/mcp/availability";
import { listMcpCallClients, listMcpCalls } from "@/server/services/mcp-call-log";
import { listMcpConnections } from "@/server/services/mcp-connections";
import { getMcpSettings } from "@/server/services/mcp-settings";

const T = TEXTS.mcp.settings;

export const metadata: Metadata = { title: T.pageTitle };

const day = new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeZone: "Europe/Prague" });
const moment = new Intl.DateTimeFormat("cs-CZ", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Europe/Prague",
});

type Search = Awaited<PageProps<"/nastaveni/asistenti">["searchParams"]>;

function one(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

// Unknown values fall back to no filter and the first page.
function callLogFilter(search: Search): CallLogFilter {
  const outcome = one(search[CALL_LOG_PARAMS.outcome]);
  const page = Number(one(search[CALL_LOG_PARAMS.page]));
  return {
    clientId: one(search[CALL_LOG_PARAMS.client]),
    outcome: outcome === "ok" || outcome === "denied" || outcome === "error" ? outcome : undefined,
    page: Number.isSafeInteger(page) && page > 1 ? page : 1,
  };
}

async function AssistantsContent({
  searchParams,
}: Pick<PageProps<"/nastaveni/asistenti">, "searchParams">) {
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
  const settings = getMcpSettings(user.id);
  const filter = callLogFilter(await searchParams);
  const calls = listMcpCalls(user.id, filter);
  const rows = calls.rows.map((row) => ({
    id: row.id,
    at: moment.format(row.at),
    clientName: row.clientName,
    tool: row.tool,
    outcome: row.outcome,
    reason: row.reason as keyof typeof TEXTS.mcp.callLog.reasons | null,
    requiredLevel: row.requiredLevel,
  }));
  const hostname = new URL(resource).hostname;
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  return (
    <>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <AssistantsForm settings={settings} address={resource} local={local} />
      <AssistantConnections connections={connections} />
      <AssistantCallLog
        rows={rows}
        filter={filter}
        hasNext={calls.hasNext}
        clients={listMcpCallClients(user.id)}
        logging={settings.logCalls}
      />
    </>
  );
}

export default function AssistantsPage({ searchParams }: PageProps<"/nastaveni/asistenti">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <AssistantsContent searchParams={searchParams} />
    </Suspense>
  );
}
