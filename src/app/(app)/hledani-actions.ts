"use server";

import { z } from "zod";
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, PER_GROUP, type SearchHit } from "@/lib/quick-search";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, RateLimitError } from "@/server/services/access";
import { searchAll } from "@/server/services/quick-search";

const queryInput = z.string().max(MAX_QUERY_LENGTH);

export async function quickSearch(q: string): Promise<{ hits: SearchHit[]; limited: boolean }> {
  const session = await requireSession();
  const parsed = queryInput.safeParse(q);
  const term = parsed.success ? parsed.data.trim() : "";
  // Checked before the limit, so typing the first letter or a refused query costs nothing.
  if (term.length < MIN_QUERY_LENGTH) return { hits: [], limited: false };
  try {
    enforceRateLimit(await actorFromRequest(), RATE_RULES.searchUser);
  } catch (error) {
    if (error instanceof RateLimitError) return { hits: [], limited: true };
    throw error;
  }
  return { hits: searchAll(session.user.id, term, PER_GROUP), limited: false };
}
