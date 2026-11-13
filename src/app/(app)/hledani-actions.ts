"use server";

import type { SearchHit } from "@/lib/quick-search";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { quickSearch as searchFor } from "@/server/services/quick-search";

export async function quickSearch(q: string): Promise<{ hits: SearchHit[]; limited: boolean }> {
  await requireSession();
  return searchFor(await actorFromRequest(), q);
}
