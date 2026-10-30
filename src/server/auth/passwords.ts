import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MIN_PASSWORD_LENGTH = 12;

let commonPasswords: Set<string> | undefined;

function loadCommonPasswords(): Set<string> {
  const lines = readFileSync(
    join(process.cwd(), "src/server/auth/common-passwords.txt"),
    "utf8",
  ).split("\n");
  return new Set(lines.filter((line) => line && !line.startsWith("#")));
}

export function isCommonPassword(password: string): boolean {
  commonPasswords ??= loadCommonPasswords();
  return commonPasswords.has(password.toLowerCase());
}
