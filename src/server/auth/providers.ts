import "server-only";
import type { SocialProviders } from "better-auth";
import { importPKCS8, SignJWT } from "jose";
import { clock } from "../clock";
import type { Env } from "../env";

export type ProviderId = "google" | "github" | "microsoft" | "apple";

const SECRET_LIFETIME_SECONDS = 180 * 86_400;

function isAppleConfigured(env: Env): boolean {
  return Boolean(
    env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY,
  );
}

export function enabledProviders(env: Env): ProviderId[] {
  const enabled: ProviderId[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) enabled.push("google");
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) enabled.push("github");
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) enabled.push("microsoft");
  if (isAppleConfigured(env)) enabled.push("apple");
  return enabled;
}

// Apple rejects secrets valid for more than 6 months (AUTH-015).
export async function appleClientSecret(env: Env): Promise<string> {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY!.replaceAll("\\n", "\n"), "ES256");
  const issuedAt = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT()
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID! })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setSubject(env.APPLE_CLIENT_ID!)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SECRET_LIFETIME_SECONDS)
    .sign(key);
}

export function socialProviders(env: Env): SocialProviders {
  const enabled = new Set(enabledProviders(env));
  return {
    ...(enabled.has("google") && {
      google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! },
    }),
    ...(enabled.has("github") && {
      github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! },
    }),
    ...(enabled.has("microsoft") && {
      microsoft: { clientId: env.MICROSOFT_CLIENT_ID!, clientSecret: env.MICROSOFT_CLIENT_SECRET! },
    }),
    ...(enabled.has("apple") && {
      apple: async () => ({
        clientId: env.APPLE_CLIENT_ID!,
        clientSecret: await appleClientSecret(env),
      }),
    }),
  };
}
