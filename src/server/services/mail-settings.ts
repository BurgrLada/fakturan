import "server-only";
import { eq } from "drizzle-orm";
import { mailSettingsSchema } from "@/lib/mail-settings";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { decryptSecret, encryptSecret } from "../crypto";
import { db } from "../db";
import { mailSettings, user } from "../db/schema";
import { scoped } from "../db/scoped";
import { env as defaultEnv, type Env } from "../env";
import { logger } from "../logger";
import { assertPublicHost, BlockedHostError } from "../mail/host-guard";
import { instanceTarget, isInstanceMailConfigured } from "../mail/instance";
import {
  buildTransport,
  deliver,
  type MailAddress,
  type MailIdentity,
  type MailTransport,
  type SmtpTarget,
} from "../mail/transport";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { mutate } from "./mutation";

const T = TEXTS.mailSettings;
const E = T.errors;

type Row = typeof mailSettings.$inferSelect;
type OwnServer = Row & { smtpHost: string; smtpPort: number; fromEmail: string };

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

function readRow(ownerId: string): Row | undefined {
  return db.select().from(mailSettings).where(scoped(ownerId).where(mailSettings)).get();
}

function hasOwnServer(row: Row | undefined): row is OwnServer {
  return Boolean(row?.smtpHost && row.smtpPort && row.fromEmail);
}

function hasCredentials(row: Row | undefined): boolean {
  return Boolean(row?.smtpUser && row.smtpPasswordEnc);
}

function auditSnapshot(row: Row | undefined) {
  return {
    host: row?.smtpHost ?? null,
    port: row?.smtpPort ?? null,
    hasCredentials: hasCredentials(row),
  };
}

function ownAuth(row: OwnServer): { ok: boolean; auth?: SmtpTarget["auth"] } {
  if (!row.smtpUser || !row.smtpPasswordEnc) return { ok: true };
  try {
    return {
      ok: true,
      auth: { user: row.smtpUser, pass: decryptSecret(row.smtpPasswordEnc) },
    };
  } catch {
    return { ok: false };
  }
}

function named(address: string, name: string | null | undefined): MailAddress {
  return name ? { name, address } : address;
}

function identityOf(row: Row | undefined, from: MailAddress): MailIdentity {
  return {
    from,
    ...(row?.replyTo ? { replyTo: row.replyTo } : {}),
    cc: row?.cc ?? [],
    bcc: row?.bcc ?? [],
  };
}

function instanceFrom(row: Row | undefined, smtpFrom: string): MailAddress {
  const address = /<([^<>]+)>\s*$/.exec(smtpFrom)?.[1] ?? smtpFrom;
  return row?.senderName ? named(address, row.senderName) : smtpFrom;
}

export function mailAvailability(
  ownerId: string,
  env: Env = defaultEnv,
): { available: boolean; source: "user" | "instance" | null } {
  const row = readRow(ownerId);
  if (hasOwnServer(row)) {
    return ownAuth(row).ok
      ? { available: true, source: "user" }
      : { available: false, source: null };
  }
  return isInstanceMailConfigured(env)
    ? { available: true, source: "instance" }
    : { available: false, source: null };
}

function ownTransport(row: OwnServer, auth: SmtpTarget["auth"], env: Env): MailTransport {
  const { smtpHost: host, smtpPort: port } = row;
  return {
    source: "user",
    identity: identityOf(row, named(row.fromEmail, row.senderName)),
    send: async (msg) => {
      // Repeated per connection: the record may have changed since it was saved.
      const { address, isPrivate } = await assertPublicHost(host, port, {
        allowPrivate: env.ALLOW_PRIVATE_MAIL_HOSTS,
      });
      return deliver(
        buildTransport({ host: address, port, auth }, { servername: host, isPrivate }),
        msg,
      );
    },
  };
}

function instanceTransport(row: Row | undefined, env: Env): MailTransport {
  return {
    source: "instance",
    identity: identityOf(row, instanceFrom(row, env.SMTP_FROM ?? "")),
    send: (msg) => deliver(buildTransport(instanceTarget(env)), msg),
  };
}

export async function resolveTransport(
  ownerId: string,
  env: Env = defaultEnv,
): Promise<MailTransport | null> {
  const row = readRow(ownerId);
  if (hasOwnServer(row)) {
    const { ok, auth } = ownAuth(row);
    return ok ? ownTransport(row, auth, env) : null;
  }
  return isInstanceMailConfigured(env) ? instanceTransport(row, env) : null;
}

export function getMailSettings(ownerId: string) {
  const row = readRow(ownerId);
  return {
    smtpHost: row?.smtpHost ?? null,
    smtpPort: row?.smtpPort ?? null,
    smtpUser: row?.smtpUser ?? null,
    fromEmail: row?.fromEmail ?? null,
    senderName: row?.senderName ?? null,
    replyTo: row?.replyTo ?? null,
    cc: row?.cc ?? [],
    bcc: row?.bcc ?? [],
    verifiedAt: row?.verifiedAt ?? null,
    hasCredentials: hasCredentials(row),
  };
}

function parseInput(raw: unknown) {
  const parsed = mailSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  return parsed.data;
}

async function assertAllowedHost(host: string, port: number, env: Env): Promise<void> {
  try {
    await assertPublicHost(host, port, { allowPrivate: env.ALLOW_PRIVATE_MAIL_HOSTS });
  } catch (error) {
    if (error instanceof BlockedHostError) throw new ServiceError(E.blockedHost);
    throw error;
  }
}

export async function saveMailSettings(
  actor: Actor,
  raw: unknown,
  env: Env = defaultEnv,
): Promise<void> {
  const userId = ownerOf(actor);
  const input = parseInput(raw);
  const host = input.smtpHost || null;
  const port = host ? input.smtpPort : null;
  if (host && port) await assertAllowedHost(host, port, env);

  mutate(actor, "mail_settings.save", (tx, audit) => {
    const row = tx.select().from(mailSettings).where(scoped(userId).where(mailSettings)).get();
    const login = host ? input.smtpUser || null : null;
    const passwordEnc = !login
      ? null
      : input.smtpPassword
        ? encryptSecret(input.smtpPassword)
        : (row?.smtpPasswordEnc ?? null);
    if (login && !passwordEnc) throw new ServiceError(E.passwordRequired);

    const fromEmail = host ? input.fromEmail : null;
    const sameServer =
      row?.smtpHost === host &&
      row.smtpPort === port &&
      row.smtpUser === login &&
      row.fromEmail === fromEmail &&
      !input.smtpPassword;
    const next = {
      smtpHost: host,
      smtpPort: port,
      smtpUser: login,
      smtpPasswordEnc: passwordEnc,
      fromEmail,
      senderName: input.senderName || null,
      replyTo: input.replyTo || null,
      cc: input.cc,
      bcc: input.bcc,
      verifiedAt: sameServer ? row.verifiedAt : null,
      updatedAt: clock.now(),
    };
    tx.insert(mailSettings)
      .values({ ...next, userId })
      .onConflictDoUpdate({ target: mailSettings.userId, set: next })
      .run();
    audit({
      entity: "mail_settings",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before: auditSnapshot(row),
      after: auditSnapshot({ ...next, userId }),
    });
  });
}

// Sender name, Reply-To and copies also apply to the instance server, so they stay (SET-052).
export function clearOwnSmtp(actor: Actor): void {
  const userId = ownerOf(actor);
  if (!readRow(userId)?.smtpHost) return;
  mutate(actor, "mail_settings.clear", (tx, audit) => {
    const row = tx.select().from(mailSettings).where(scoped(userId).where(mailSettings)).get();
    tx.update(mailSettings)
      .set({
        smtpHost: null,
        smtpPort: null,
        smtpUser: null,
        smtpPasswordEnc: null,
        fromEmail: null,
        verifiedAt: null,
        updatedAt: clock.now(),
      })
      .where(scoped(userId).where(mailSettings))
      .run();
    audit({
      entity: "mail_settings",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before: auditSnapshot(row),
      after: auditSnapshot(undefined),
    });
  });
}

function accountEmail(userId: string): string {
  const account = db.select({ email: user.email }).from(user).where(eq(user.id, userId)).get();
  if (!account) throw new ServiceError(E.forbidden);
  return account.email;
}

function markVerified(actor: Actor, userId: string): void {
  mutate(actor, "mail_settings.test", (tx, audit) => {
    tx.update(mailSettings)
      .set({ verifiedAt: clock.now() })
      .where(scoped(userId).where(mailSettings))
      .run();
    audit({ entity: "mail_settings", entityId: userId, ownerId: userId, scope: "user" });
  });
}

// One generic failure on purpose: distinct errors would turn this page into a network scanner.
export async function sendTestMail(actor: Actor, env: Env = defaultEnv): Promise<void> {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.sendUser);
  const transport = await resolveTransport(userId, env);
  if (!transport) throw new ServiceError(E.unavailable);
  const { from, replyTo } = transport.identity;
  try {
    await transport.send({
      from,
      ...(replyTo ? { replyTo } : {}),
      to: accountEmail(userId),
      subject: T.testSubject,
      text: T.testBody,
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof BlockedHostError) throw new ServiceError(E.blockedHost);
    logger.warn("Zkušební e-mail se nepodařilo odeslat", {
      code: (error as { code?: string }).code,
    });
    throw new ServiceError(E.testFailed);
  }
  if (transport.source === "user") markVerified(actor, userId);
}
