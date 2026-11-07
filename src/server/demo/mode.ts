import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/schema";
import { env } from "../env";

export function isDemo(): boolean {
  return env.DEMO_MODE;
}

// The demo account is the one with DEMO_EMAIL, so a reset that recreates it keeps the guard.
export function demoUserId(): string | null {
  if (!env.DEMO_MODE || !env.DEMO_EMAIL) return null;
  const row = db
    .select({ id: user.id })
    .from(user)
    .where(eq(sql`lower(${user.email})`, env.DEMO_EMAIL.toLowerCase()))
    .get();
  return row?.id ?? null;
}

export function isDemoAccount(userId: string): boolean {
  return userId !== "" && demoUserId() === userId;
}
