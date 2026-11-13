import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { session, user } from "./auth";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const flag = (name: string) => integer(name, { mode: "boolean" });

// Tables of the Better Auth jwt, oauth-provider (through @better-auth/mcp) and cimd plugins. The
// drizzle adapter maps fields by these TypeScript keys, so they keep the plugins' names. On SQLite
// the adapter stores string[] and json fields as JSON text.
// None of them is account data: no backup, export or restore (MCP-042). Deleting a user cascades
// to their tokens and consents; clients are instance-wide and stay.

export const jwks = sqliteTable("jwks", {
  id: text().primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at"),
  alg: text(),
  crv: text(),
});

export const oauthClient = sqliteTable(
  "oauth_client",
  {
    id: text().primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: flag("disabled").default(false),
    skipConsent: flag("skip_consent"),
    enableEndSession: flag("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text(),
    clientCredentialsScopes: text("client_credentials_scopes"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text(),
    tos: text(),
    policy: text(),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: flag("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text(),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    requirePKCE: flag("require_pkce"),
    dpopBoundAccessTokens: flag("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: text(),
  },
  (t) => [index("oauth_client_user_idx").on(t.userId)],
);

export const oauthResource = sqliteTable("oauth_resource", {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes"),
  customClaims: text("custom_claims"),
  dpopBoundAccessTokensRequired: flag("dpop_bound_access_tokens_required").default(false),
  disabled: flag("disabled").default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: text(),
});

export const oauthClientResource = sqliteTable(
  "oauth_client_resource",
  {
    id: text().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: text(),
    createdAt: timestamp("created_at"),
  },
  (t) => [
    index("oauth_client_resource_client_idx").on(t.clientId),
    index("oauth_client_resource_resource_idx").on(t.resourceId),
    uniqueIndex("oauth_client_resource_uidx").on(t.clientId, t.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text(),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    revoked: timestamp("revoked"),
    rotatedAt: timestamp("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at"),
    authTime: timestamp("auth_time"),
    confirmation: text(),
    scopes: text().notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_idx").on(t.clientId),
    index("oauth_refresh_token_session_idx").on(t.sessionId),
    index("oauth_refresh_token_user_idx").on(t.userId),
    index("oauth_refresh_token_code_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text(),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    revoked: timestamp("revoked"),
    confirmation: text(),
    scopes: text().notNull(),
  },
  (t) => [
    index("oauth_access_token_client_idx").on(t.clientId),
    index("oauth_access_token_session_idx").on(t.sessionId),
    index("oauth_access_token_user_idx").on(t.userId),
    index("oauth_access_token_code_idx").on(t.authorizationCodeId),
    index("oauth_access_token_refresh_idx").on(t.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text(),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    scopes: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    // Ours, not the plugin's: when the assistant last called a tool, written at most once a minute
    // and outside the audit (MCP-041). The plugin updates a consent in place, so it survives.
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    index("oauth_consent_client_idx").on(t.clientId),
    index("oauth_consent_user_idx").on(t.userId),
  ],
);

// Single-use tombstones of client assertion jti values; the id is the jti.
export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
  id: text().primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
});
