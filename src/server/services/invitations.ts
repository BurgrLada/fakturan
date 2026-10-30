import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Actor } from "../audit/context";
import { emailHash } from "../audit/email-hash";
import { hashToken } from "../auth/signup-guard";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { invitation, user } from "../db/schema";
import { env } from "../env";
import { isInstanceMailConfigured, sendInstanceMail } from "../mail/instance";
import { RATE_RULES } from "../rate-limit";
import { assertAdmin, enforceRateLimit, ServiceError } from "./access";
import { mutate } from "./mutation";

const INVITE_TTL_MS = 7 * 86_400_000;

export type InvitationLink = { url: string; mailSent: boolean };

export type InvitationCheck =
  | { status: "valid"; email: string; expiresAt: Date }
  | { status: "used" | "expired" | "revoked" | "unknown" };

function mintToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token), expiresAt: nextExpiry() };
}

function nextExpiry(): Date {
  return new Date(clock.now().getTime() + INVITE_TTL_MS);
}

function inviteUrl(token: string): string {
  return new URL(`/pozvanka/${token}`, env.BETTER_AUTH_URL).href;
}

function auditEntry(id: string, email: string) {
  return {
    entity: "invitation",
    entityId: id,
    ownerId: null,
    scope: "instance",
    after: { emailHash: emailHash(email, env), role: "user" },
  } as const;
}

async function deliver(actor: Actor, id: string, email: string, url: string): Promise<boolean> {
  if (!isInstanceMailConfigured()) return false;
  try {
    await sendInstanceMail({
      to: email,
      subject: "Pozvánka do Fakturanu",
      text: `Účet si založíte na této adrese, odkaz platí 7 dní:\n\n${url}\n`,
    });
    return true;
  } catch {
    mutate(actor, "invitation.mail_failed", (_tx, audit) => audit(auditEntry(id, email)));
    return false;
  }
}

function assertNotMember(tx: Tx, email: string): void {
  const member = tx
    .select({ id: user.id })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email));
  if (member.get()) throw new ServiceError("Účet s tímto e-mailem už existuje");
}

function assertNoPendingInvite(tx: Tx, email: string, ignoredId = ""): void {
  const pending = tx
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(sql`lower(${invitation.email})`, email),
        ne(invitation.id, ignoredId),
        isNull(invitation.acceptedAt),
        isNull(invitation.revokedAt),
        gt(invitation.expiresAt, clock.now()),
      ),
    );
  if (pending.get()) throw new ServiceError("Tento e-mail už má platnou pozvánku");
}

export async function createInvitation(actor: Actor, rawEmail: string): Promise<InvitationLink> {
  assertAdmin(db, actor);
  enforceRateLimit(actor, RATE_RULES.invitationsUser);
  const email = rawEmail.trim().toLowerCase();
  const { token, tokenHash, expiresAt } = mintToken();
  const id = randomUUID();
  mutate(actor, "invitation.create", (tx, audit) => {
    assertAdmin(tx, actor);
    assertNotMember(tx, email);
    assertNoPendingInvite(tx, email);
    tx.insert(invitation)
      .values({
        id,
        email,
        tokenHash,
        role: "user",
        invitedBy: actor.userId,
        createdAt: clock.now(),
        expiresAt,
      })
      .run();
    audit(auditEntry(id, email));
  });
  const url = inviteUrl(token);
  return { url, mailSent: await deliver(actor, id, email, url) };
}

function openInvitation(tx: Tx, id: string) {
  const row = tx.select().from(invitation).where(eq(invitation.id, id)).get();
  if (!row || row.acceptedAt || row.revokedAt) throw new ServiceError("Pozvánka už neplatí");
  return row;
}

export function revokeInvitation(actor: Actor, id: string): void {
  mutate(actor, "invitation.revoke", (tx, audit) => {
    assertAdmin(tx, actor);
    const row = openInvitation(tx, id);
    tx.update(invitation).set({ revokedAt: clock.now() }).where(eq(invitation.id, id)).run();
    audit(auditEntry(id, row.email));
  });
}

// Only the hash is stored, so resending cannot repeat the old link; it issues a new one instead.
export async function resendInvitation(actor: Actor, id: string): Promise<InvitationLink> {
  assertAdmin(db, actor);
  enforceRateLimit(actor, RATE_RULES.invitationsUser);
  const { token, tokenHash, expiresAt } = mintToken();
  const email = mutate(actor, "invitation.resend", (tx, audit) => {
    assertAdmin(tx, actor);
    const row = openInvitation(tx, id);
    assertNotMember(tx, row.email.toLowerCase());
    assertNoPendingInvite(tx, row.email.toLowerCase(), id);
    tx.update(invitation).set({ tokenHash, expiresAt }).where(eq(invitation.id, id)).run();
    audit(auditEntry(id, row.email));
    return row.email;
  });
  const url = inviteUrl(token);
  return { url, mailSent: await deliver(actor, id, email, url) };
}

export function inspectInvitation(token: string): InvitationCheck {
  const row = db
    .select()
    .from(invitation)
    .where(eq(invitation.tokenHash, hashToken(token)))
    .get();
  if (!row) return { status: "unknown" };
  if (row.acceptedAt) return { status: "used" };
  if (row.revokedAt) return { status: "revoked" };
  if (row.expiresAt <= clock.now()) return { status: "expired" };
  return { status: "valid", email: row.email, expiresAt: row.expiresAt };
}

export function listInvitations(actor: Actor) {
  assertAdmin(db, actor);
  const now = clock.now();
  return db
    .select({
      id: invitation.id,
      email: invitation.email,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(and(isNull(invitation.acceptedAt), isNull(invitation.revokedAt)))
    .orderBy(desc(invitation.createdAt))
    .all()
    .map((row) => ({ ...row, expired: row.expiresAt <= now }));
}
