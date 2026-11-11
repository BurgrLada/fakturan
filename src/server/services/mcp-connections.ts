import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { db, type Tx } from "../db";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../db/schema";
import { consentInfo } from "../mcp/consent-info";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

export { touchMcpConnection } from "../mcp/connection-use";

const E = TEXTS.mcp.connections.errors;

// A connection is the consent row of one user and one client (MCP-041).
export type McpConnection = {
  clientId: string;
  name: string;
  host: string;
  connectedAt: Date;
  lastUsedAt: Date | null;
};

type ClientRow = Pick<typeof oauthClient.$inferSelect, "clientId" | "name" | "redirectUris">;

function firstRedirectUri(json: string): string {
  try {
    const uris: unknown = JSON.parse(json);
    return Array.isArray(uris) && typeof uris[0] === "string" ? uris[0] : "";
  } catch {
    return "";
  }
}

function isUrl(value: string): boolean {
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

// Shown the same way as on the consent page: the client's own name and the host it answers on.
function describe(client: ClientRow): { name: string; host: string } {
  const { name, host } = consentInfo({
    clientName: client.name,
    redirectUri: firstRedirectUri(client.redirectUris),
    clientIdUrl: isUrl(client.clientId) ? client.clientId : null,
  });
  return { name, host };
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

export function listMcpConnections(ownerId: string): McpConnection[] {
  return db
    .select({
      clientId: oauthClient.clientId,
      name: oauthClient.name,
      redirectUris: oauthClient.redirectUris,
      connectedAt: oauthConsent.createdAt,
      lastUsedAt: oauthConsent.lastUsedAt,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, ownerId))
    .orderBy(desc(oauthConsent.createdAt), desc(oauthConsent.id))
    .all()
    .map((row) => ({
      clientId: row.clientId,
      ...describe(row),
      connectedAt: row.connectedAt,
      lastUsedAt: row.lastUsedAt ?? null,
    }));
}

// Read on every tool call (MCP-012): a token of a disconnected client is refused at once.
export function isMcpConnected(ownerId: string, clientId: string): boolean {
  const row = db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, ownerId), eq(oauthConsent.clientId, clientId)))
    .get();
  return row !== undefined;
}

function findClient(tx: Pick<Tx, "select">, clientId: string): ClientRow | undefined {
  return tx
    .select({
      clientId: oauthClient.clientId,
      name: oauthClient.name,
      redirectUris: oauthClient.redirectUris,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .get();
}

// Deletes the consent and every stored token of this user and client; the client stays, it is
// instance-wide (MCP-013, MCP-042). JWT access tokens are not stored: the MCP endpoint refuses them
// because isMcpConnected is now false.
export function disconnectMcpClient(actor: Actor, clientId: string): void {
  const ownerId = ownerOf(actor);
  mutate(actor, "mcp.disconnected", (tx, audit) => {
    const pair = (
      table: typeof oauthConsent | typeof oauthRefreshToken | typeof oauthAccessToken,
    ) => and(eq(table.userId, ownerId), eq(table.clientId, clientId));
    const consents = tx.delete(oauthConsent).where(pair(oauthConsent)).run().changes;
    const client = findClient(tx, clientId);
    if (consents === 0 || !client) throw new ServiceError(E.notFound);
    tx.delete(oauthAccessToken).where(pair(oauthAccessToken)).run();
    tx.delete(oauthRefreshToken).where(pair(oauthRefreshToken)).run();
    audit({
      entity: "mcp_client",
      entityId: clientId,
      ownerId,
      scope: "user",
      before: { clientId, name: describe(client).name },
    });
  });
}

// The grant itself (MCP-031). Called after the consent endpoint accepted; a later authorization
// that the provider lets through on the remembered consent is not a new grant and is not recorded.
export function recordMcpConnected(actor: Actor, clientId: string): void {
  const ownerId = ownerOf(actor);
  mutate(actor, "mcp.connected", (tx, audit) => {
    const client = findClient(tx, clientId);
    if (!client) throw new ServiceError(E.notFound);
    const { name, host } = describe(client);
    audit({
      entity: "mcp_client",
      entityId: clientId,
      ownerId,
      scope: "user",
      after: { clientId, name, host },
    });
  });
}
