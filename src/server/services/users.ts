import "server-only";
import { and, asc, count, eq, max, ne, or, sql } from "drizzle-orm";
import type { Actor } from "../audit/context";
import { auth } from "../auth";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import {
  account,
  auditLog,
  automationSettings,
  auditPurge,
  bankAccount,
  catalogItem,
  customer,
  file,
  invitation,
  invoice,
  invoiceLine,
  invoiceTag,
  invoiceTemplate,
  invoiceVersion,
  job,
  notification,
  numberSeries,
  numberSeriesCounter,
  preferences,
  rateLimit,
  session,
  supplier,
  tag,
  unit,
  user,
  verification,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { logger } from "../logger";
import { removeUserDir } from "../files/store";
import { cancelUserJobs } from "../jobs/queue";
import { RATE_RULES } from "../rate-limit";
import { assertAdmin, enforceRateLimit, ServiceError } from "./access";
import { mutate } from "./mutation";

export type Role = "admin" | "user";

// Every table with account data, enforced by a schema test in users.test.ts (ADM-006). Deleted in
// this order, so a table with a non-cascading foreign key must precede the table it references.
export const USER_OWNED_TABLES = [
  session,
  account,
  supplier,
  invoiceTag,
  tag,
  invoiceVersion,
  invoiceLine,
  invoice,
  invoiceTemplate,
  bankAccount,
  customer,
  catalogItem,
  unit,
  numberSeriesCounter,
  numberSeries,
  preferences,
  file,
  job,
  automationSettings,
  notification,
];

const REAUTH_WINDOW_MS = 15 * 60_000;

function targetUser(tx: Tx, userId: string) {
  const row = tx.select().from(user).where(eq(user.id, userId)).get();
  if (!row) throw new ServiceError("Uživatel neexistuje");
  return row;
}

type Target = ReturnType<typeof targetUser>;

// A deactivated admin cannot log in, so they do not count towards keeping the instance manageable.
function isOnlyActiveAdmin(tx: Tx, target: Target): boolean {
  if (target.role !== "admin" || target.banned) return false;
  const active = tx
    .select({ n: count() })
    .from(user)
    .where(and(eq(user.role, "admin"), sql`coalesce(${user.banned}, 0) = 0`))
    .get();
  return (active?.n ?? 0) <= 1;
}

function assertNotLastAdmin(tx: Tx, target: Target): void {
  if (isOnlyActiveAdmin(tx, target)) {
    throw new ServiceError("Poslední administrátor musí zůstat aktivní");
  }
}

function assertNotSelf(actor: Actor, userId: string): void {
  if (actor.userId === userId) {
    throw new ServiceError("Vlastní účet se v administraci měnit nedá");
  }
}

export function listUsers(actor: Actor) {
  assertAdmin(db, actor);
  const logins = db
    .select({ ownerId: auditLog.ownerId, at: max(auditLog.at) })
    .from(auditLog)
    .where(eq(auditLog.action, "auth.login"))
    .groupBy(auditLog.ownerId)
    .all();
  const lastLogin = new Map(logins.map((row) => [row.ownerId, row.at]));
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(asc(user.createdAt))
    .all()
    .map(({ banned, ...row }) => ({
      ...row,
      status: banned ? ("deactivated" as const) : ("active" as const),
      lastLoginAt: lastLogin.get(row.id) ?? null,
    }));
}

export function setRole(actor: Actor, userId: string, role: Role): void {
  assertAdmin(db, actor);
  assertNotSelf(actor, userId);
  const current = db.select({ role: user.role }).from(user).where(eq(user.id, userId)).get();
  if (current?.role === role) return;
  mutate(actor, "user.role_change", (tx, audit) => {
    assertAdmin(tx, actor);
    const target = targetUser(tx, userId);
    if (role !== "admin") assertNotLastAdmin(tx, target);
    tx.update(user).set({ role, updatedAt: clock.now() }).where(eq(user.id, userId)).run();
    audit({
      entity: "user",
      entityId: userId,
      ownerId: userId,
      scope: "instance",
      before: { role: target.role },
      after: { role },
    });
  });
}

export function deactivateUser(actor: Actor, userId: string): void {
  mutate(actor, "user.deactivate", (tx, audit) => {
    assertAdmin(tx, actor);
    assertNotSelf(actor, userId);
    const target = targetUser(tx, userId);
    assertNotLastAdmin(tx, target);
    tx.update(user).set({ banned: true, updatedAt: clock.now() }).where(eq(user.id, userId)).run();
    // In the same transaction, so a commit can never leave a banned user with a live session.
    const revoked = tx.delete(session).where(scoped(userId).where(session)).run();
    cancelUserJobs(tx, userId);
    audit({
      entity: "user",
      entityId: userId,
      ownerId: userId,
      scope: "instance",
      before: { banned: Boolean(target.banned) },
      after: { banned: true, revokedSessions: revoked.changes },
    });
  });
}

export function reactivateUser(actor: Actor, userId: string): void {
  mutate(actor, "user.reactivate", (tx, audit) => {
    assertAdmin(tx, actor);
    const target = targetUser(tx, userId);
    tx.update(user).set({ banned: false, updatedAt: clock.now() }).where(eq(user.id, userId)).run();
    audit({
      entity: "user",
      entityId: userId,
      ownerId: userId,
      scope: "instance",
      before: { banned: Boolean(target.banned) },
      after: { banned: false },
    });
  });
}

// Removes everything naming the account. The closing row is the instance's record of the deletion
// (AUD-010): ownerless, and only the now meaningless account id remains.
function purgeAccount(
  tx: Tx,
  target: Target,
  audit: Parameters<Parameters<typeof mutate>[2]>[1],
  self: boolean,
): void {
  const email = target.email.toLowerCase();
  for (const table of USER_OWNED_TABLES) {
    tx.delete(table).where(scoped(target.id).where(table)).run();
  }
  tx.delete(invitation)
    .where(or(eq(invitation.acceptedUserId, target.id), eq(sql`lower(${invitation.email})`, email)))
    .run();
  tx.delete(verification).where(eq(verification.value, target.id)).run();
  tx.delete(rateLimit)
    .where(
      or(
        sql`instr(${rateLimit.key}, ${email}) > 0`,
        sql`instr(${rateLimit.key}, ${target.id}) > 0`,
      ),
    )
    .run();
  tx.delete(user).where(eq(user.id, target.id)).run();

  tx.insert(auditPurge).values({ ownerId: target.id }).onConflictDoNothing().run();
  tx.delete(auditLog).where(eq(auditLog.ownerId, target.id)).run();
  tx.delete(auditPurge).where(eq(auditPurge.ownerId, target.id)).run();

  audit({
    entity: "user",
    entityId: target.id,
    ownerId: null,
    scope: "instance",
    after: { self },
  });
}

function removeAccountFiles(userId: string): void {
  try {
    removeUserDir(userId);
  } catch (error) {
    logger.warn("Složku souborů smazaného účtu se nepodařilo odstranit", { error });
  }
}

export function deleteUser(actor: Actor, userId: string, confirmEmail: string): void {
  mutate(actor, "user.delete", (tx, audit) => {
    assertAdmin(tx, actor);
    assertNotSelf(actor, userId);
    const target = targetUser(tx, userId);
    if (confirmEmail.trim().toLowerCase() !== target.email.toLowerCase()) {
      throw new ServiceError("Opsaný e-mail nesouhlasí");
    }
    assertNotLastAdmin(tx, target);
    purgeAccount(tx, target, audit, false);
  });
  removeAccountFiles(userId);
}

function passwordHash(userId: string): string | null {
  const credential = db
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .get();
  return credential?.hash ?? null;
}

export function hasPassword(userId: string): boolean {
  return passwordHash(userId) !== null;
}

async function assertReauthenticated(
  actor: Actor,
  userId: string,
  current: { createdAt: Date },
  password: string | undefined,
): Promise<void> {
  const hash = passwordHash(userId);
  if (hash) {
    const hasher = (await auth.$context).password;
    if (password && (await hasher.verify({ hash, password }))) return;
    mutate(actor, "user.delete_failed", (_tx, audit) =>
      audit({ entity: "user", entityId: userId, ownerId: userId, scope: "instance" }),
    );
    throw new ServiceError("Nesprávné heslo");
  }
  if (clock.now().getTime() - current.createdAt.getTime() > REAUTH_WINDOW_MS) {
    throw new ServiceError("Kvůli bezpečnosti se znovu přihlaste a akci zopakujte");
  }
}

// Accounts without a password prove themselves by a fresh login (ADM-009).
export async function deleteOwnAccount(
  actor: Actor,
  current: { createdAt: Date },
  password: string | undefined,
): Promise<void> {
  const userId = actor.userId;
  if (!userId) throw new ServiceError("Na tuto akci nemáte oprávnění");
  enforceRateLimit(actor, RATE_RULES.accountDeleteUser);
  await assertReauthenticated(actor, userId, current, password);
  // The closing row outlives the account, so it must not carry the leaver's id, IP or user agent.
  const anonymous = { userId: null, source: actor.source, requestId: actor.requestId };
  mutate(anonymous, "user.delete", (tx, audit) => {
    const target = targetUser(tx, userId);
    const others = tx.select({ n: count() }).from(user).where(ne(user.id, userId)).get();
    if (isOnlyActiveAdmin(tx, target) && (others?.n ?? 0) > 0) {
      throw new ServiceError("Poslední administrátor nemůže smazat účet, dokud tu jsou jiní");
    }
    purgeAccount(tx, target, audit, true);
  });
  removeAccountFiles(userId);
}
