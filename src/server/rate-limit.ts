import "server-only";
import { eq, lt } from "drizzle-orm";
import { clock } from "./clock";
import { db } from "./db";
import { rateLimit } from "./db/schema";

// Longer than any rule window, so only rows that can no longer block anyone are removed.
const STALE_AFTER_MS = 2 * 3_600_000;

export type RateRule = { name: string; limit: number; windowSeconds: number };

const rule = (name: string, limit: number, windowSeconds: number): RateRule => ({
  name,
  limit,
  windowSeconds,
});

export const RATE_RULES = {
  loginIpEmail: rule("loginIpEmail", 5, 60),
  loginIp: rule("loginIp", 20, 60),
  resetPasswordEmail: rule("resetPasswordEmail", 3, 3600),
  signupIp: rule("signupIp", 5, 3600),
  invitationsUser: rule("invitationsUser", 20, 3600),
  sendUser: rule("sendUser", 60, 60),
  importUser: rule("importUser", 60, 60),
  exportUser: rule("exportUser", 60, 60),
} as const satisfies Record<string, RateRule>;

// Fixed window. Denied attempts are not counted, so hammering a blocked key does not extend it.
export function checkRateLimit(
  key: string,
  rateRule: RateRule,
): { allowed: boolean; retryAfterSeconds: number } {
  const id = `${rateRule.name}:${key}`;
  const now = clock.now();
  const windowMs = rateRule.windowSeconds * 1000;

  return db.transaction(
    (tx) => {
      const row = tx.select().from(rateLimit).where(eq(rateLimit.key, id)).get();
      if (!row || row.windowStart.getTime() + windowMs <= now.getTime()) {
        tx.insert(rateLimit)
          .values({ key: id, windowStart: now, count: 1 })
          .onConflictDoUpdate({ target: rateLimit.key, set: { windowStart: now, count: 1 } })
          .run();
        tx.delete(rateLimit)
          .where(lt(rateLimit.windowStart, new Date(now.getTime() - STALE_AFTER_MS)))
          .run();
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (row.count >= rateRule.limit) {
        const remainingMs = row.windowStart.getTime() + windowMs - now.getTime();
        return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
      }
      tx.update(rateLimit)
        .set({ count: row.count + 1 })
        .where(eq(rateLimit.key, id))
        .run();
      return { allowed: true, retryAfterSeconds: 0 };
    },
    { behavior: "immediate" },
  );
}
