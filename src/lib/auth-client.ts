import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// On a page the OAuth provider signed (login, consent), the plugin sends that page's query with
// every POST, so a login continues the assistant's authorization (MCP-003).
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });

const MESSAGES: Record<string, string> = {
  INVITE_REQUIRED: "Přístup je jen na pozvánku.",
  PASSWORD_COMPROMISED: "Toto heslo je mezi známými uniklými hesly, zvolte jiné.",
  PASSWORD_WEAK: "Toto heslo je příliš jednoduché, zvolte jiné.",
  PASSWORD_TOO_SHORT: "Heslo musí mít aspoň 12 znaků.",
  PASSWORD_TOO_LONG: "Heslo je příliš dlouhé.",
  INVALID_EMAIL_OR_PASSWORD: "Nesprávný e-mail nebo heslo.",
  EMAIL_NOT_VERIFIED: "E-mail ještě není potvrzený. Poslali jsme vám nový odkaz.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Účet s tímto e-mailem už existuje.",
  INVALID_TOKEN: "Odkaz už neplatí, požádejte o nový.",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "Poslední způsob přihlášení nejde odebrat.",
  SESSION_NOT_FRESH: "Z bezpečnostních důvodů se nejdřív znovu přihlaste.",
  BANNED_USER: "Tento účet je deaktivovaný.",
};

export function authErrorMessage(code: string | undefined): string {
  return (code && MESSAGES[code]) || "Něco se nepovedlo, zkuste to prosím znovu.";
}
