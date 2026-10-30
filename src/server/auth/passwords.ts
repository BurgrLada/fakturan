import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MIN_PASSWORD_LENGTH = 12;
const MIN_DISTINCT_CHARACTERS = 5;

let commonPasswords: Set<string> | undefined;

function loadCommonPasswords(): Set<string> {
  const lines = readFileSync(
    join(process.cwd(), "src/server/auth/common-passwords.txt"),
    "utf8",
  ).split("\n");
  return new Set(lines.filter((line) => line && !line.startsWith("#")));
}

export type PasswordProblem = "PASSWORD_COMPROMISED" | "PASSWORD_WEAK";

export function passwordProblem(password: string, email: string | null): PasswordProblem | null {
  const normalized = password.toLowerCase();
  commonPasswords ??= loadCommonPasswords();
  if (commonPasswords.has(normalized)) return "PASSWORD_COMPROMISED";
  if (new Set(password).size < MIN_DISTINCT_CHARACTERS) return "PASSWORD_WEAK";
  if (email && normalized === email.toLowerCase().split("@")[0]) return "PASSWORD_WEAK";
  return null;
}
