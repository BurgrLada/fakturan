import "server-only";
import { createHash } from "node:crypto";
import { and, count, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { clock } from "../clock";
import type { Db, Tx } from "../db";
import { instanceMeta, invitation, user } from "../db/schema";

export const INVITE_COOKIE = "fakturan_invite";

const FIRST_ADMIN_KEY = "first_admin_claimed";
// The claim commits before Better Auth inserts the user, so a crash in between would otherwise
// leave an empty instance that nobody can ever register on.
const CLAIM_TTL_MS = 60_000;

export type SignupDecision =
  | { allowed: true; role: "admin" | "user"; invitationId: string | null }
  | { allowed: false };

type Reader = Pick<Db | Tx, "select">;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hasNoUsers(q: Reader): boolean {
  return (q.select({ n: count() }).from(user).get()?.n ?? 0) === 0;
}

function claimFirstAdmin(tx: Tx): boolean {
  const now = clock.now();
  const value = now.toISOString();
  const inserted = tx
    .insert(instanceMeta)
    .values({ key: FIRST_ADMIN_KEY, value })
    .onConflictDoNothing()
    .run();
  if (inserted.changes > 0) return true;
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const retaken = tx
    .update(instanceMeta)
    .set({ value })
    .where(and(eq(instanceMeta.key, FIRST_ADMIN_KEY), lt(instanceMeta.value, staleBefore)))
    .run();
  return retaken.changes > 0;
}

function usableInvite(q: Reader, match: ReturnType<typeof eq>) {
  return q
    .select()
    .from(invitation)
    .where(
      and(
        match,
        isNull(invitation.acceptedAt),
        isNull(invitation.revokedAt),
        gt(invitation.expiresAt, clock.now()),
      ),
    )
    .get();
}

function inviteByToken(q: Reader, token: string | undefined) {
  return token ? usableInvite(q, eq(invitation.tokenHash, hashToken(token))) : undefined;
}

export function isSignupOpen(q: Reader, inviteToken?: string): boolean {
  return hasNoUsers(q) || inviteByToken(q, inviteToken) !== undefined;
}

// A token alone is enough, whatever the email: Apple hides the real address (AUTH-007). Without a
// token, an address only proves anything once a provider has verified it, so password signups must
// not pass `verifiedEmail`.
export function canRegister(
  tx: Tx,
  email: string,
  inviteToken?: string,
  { verifiedEmail = false }: { verifiedEmail?: boolean } = {},
): SignupDecision {
  if (hasNoUsers(tx) && claimFirstAdmin(tx)) {
    return { allowed: true, role: "admin", invitationId: null };
  }
  const invite =
    inviteByToken(tx, inviteToken) ??
    (verifiedEmail
      ? usableInvite(tx, eq(sql`lower(${invitation.email})`, email.toLowerCase()))
      : undefined);
  if (!invite) return { allowed: false };
  tx.update(invitation).set({ acceptedAt: clock.now() }).where(eq(invitation.id, invite.id)).run();
  return { allowed: true, role: invite.role, invitationId: invite.id };
}
