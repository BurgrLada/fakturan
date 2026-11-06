import { RESTORE_LIMITS } from "@/lib/backup-format";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { UploadTooLarge, writeCapped } from "@/server/files/upload";
import { RateLimitError, ServiceError } from "@/server/services/access";
import {
  assertRestoreAllowed,
  beginRestoreUpload,
  startRestore,
  touchRestoreUpload,
} from "@/server/services/account-restore";
import { clock } from "@/server/clock";
import { failExport } from "@/server/services/exports";

const E = TEXTS.restore.errors;
const TOUCH_MS = 60_000;

const reply = (status: number, body: Record<string, unknown> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// R-35: a backup has its own route and a 1 GiB limit; the body goes straight to the account's
// folder under the id the restore then runs with, and anything refused leaves nothing behind.
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return reply(403);
  if (!(await getCurrentSession())) return reply(401);
  const actor = await actorFromRequest();
  const userId = actor.userId!;
  const declared = Number(request.headers.get("content-length") ?? "0");
  let id: string | null = null;
  try {
    assertRestoreAllowed(actor);
    if (Number.isFinite(declared) && declared > RESTORE_LIMITS.archiveBytes) {
      throw new UploadTooLarge();
    }
    id = beginRestoreUpload(actor).id;
    const upload = id;
    let touchedAt = clock.now().getTime();
    await writeCapped(userId, upload, request.body, RESTORE_LIMITS.archiveBytes, () => {
      const now = clock.now().getTime();
      if (now - touchedAt < TOUCH_MS) return;
      touchedAt = now;
      touchRestoreUpload(userId, upload);
    });
    return reply(200, startRestore(actor, id));
  } catch (error) {
    if (id) failExport(userId, id, TEXTS.restore.failed);
    await request.body?.cancel().catch(() => {});
    if (error instanceof UploadTooLarge) return reply(413, { error: E.tooLarge });
    if (error instanceof RateLimitError) return reply(429, { error: error.message });
    if (error instanceof ServiceError) return reply(422, { error: error.message });
    throw error;
  }
}
