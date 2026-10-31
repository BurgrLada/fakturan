import "server-only";
import { randomUUID } from "node:crypto";
import { LANGUAGES, type Language } from "@/lib/preferences";
import {
  emailTemplateSchema,
  mailContentSchema,
  MESSAGE_KINDS,
  type MessageKind,
} from "@/lib/email-template";
import { formatMoney } from "@/lib/money";
import { amountDue } from "@/lib/qr-payload";
import { formatCalendarDate, renderVariables } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { emailTemplate } from "../db/schema";
import { scoped } from "../db/scoped";
import { DEFAULT_MAIL_CONTENT, type MailContent } from "../mail/defaults";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { getCustomer } from "./customers";
import { loadInvoiceDocument, variablesFor } from "./invoice-document";
import { fileNameFor } from "./invoice-pdf";
import { getMailSettings } from "./mail-settings";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

const E = TEXTS.emailTemplates.errors;

const SUBJECT_LIMIT = 200;

// Cuts on grapheme boundaries so a surrogate pair or combining mark is never split.
function capSubject(subject: string): string {
  if (subject.length <= SUBJECT_LIMIT) return subject;
  let out = "";
  for (const { segment } of new Intl.Segmenter().segment(subject)) {
    if (out.length + segment.length > SUBJECT_LIMIT) break;
    out += segment;
  }
  return out.trimEnd();
}

export type MailDraft = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachmentName: string;
};

type Row = typeof emailTemplate.$inferSelect;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

function readRow(ownerId: string, kind: MessageKind, language: Language): Row | undefined {
  return db
    .select()
    .from(emailTemplate)
    .where(
      scoped(ownerId).where(emailTemplate, (t, { and, eq }) =>
        and(eq(t.kind, kind), eq(t.language, language)),
      ),
    )
    .get();
}

export function getEmailTemplate(
  ownerId: string,
  kind: MessageKind,
  language: Language,
): MailContent {
  const row = readRow(ownerId, kind, language);
  return row ? { subject: row.subject, body: row.body } : DEFAULT_MAIL_CONTENT[language][kind];
}

export function listEmailTemplates(ownerId: string) {
  const custom = new Set(
    db
      .select({ kind: emailTemplate.kind, language: emailTemplate.language })
      .from(emailTemplate)
      .where(scoped(ownerId).where(emailTemplate))
      .all()
      .map((row) => `${row.kind}:${row.language}`),
  );
  return LANGUAGES.flatMap((language) =>
    MESSAGE_KINDS.map((kind) => ({
      kind,
      language,
      ...getEmailTemplate(ownerId, kind, language),
      custom: custom.has(`${kind}:${language}`),
    })),
  );
}

export function saveEmailTemplate(actor: Actor, raw: unknown): void {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.mailSaveUser);
  const parsed = emailTemplateSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  const { kind, language, subject, body } = parsed.data;

  mutate(actor, "email_template.save", (tx, audit) => {
    const existing = tx
      .select()
      .from(emailTemplate)
      .where(
        scoped(userId).where(emailTemplate, (t, { and, eq }) =>
          and(eq(t.kind, kind), eq(t.language, language)),
        ),
      )
      .get();
    const id = existing?.id ?? randomUUID();
    tx.insert(emailTemplate)
      .values({ id, userId, kind, language, subject, body, updatedAt: clock.now() })
      .onConflictDoUpdate({
        target: [emailTemplate.userId, emailTemplate.kind, emailTemplate.language],
        set: { subject, body, updatedAt: clock.now() },
      })
      .run();
    audit({
      entity: "email_template",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: existing && { kind, language, subject: existing.subject, body: existing.body },
      after: { kind, language, subject, body },
    });
  });
}

export function resetEmailTemplate(actor: Actor, kind: MessageKind, language: Language): void {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.mailSaveUser);
  if (!readRow(userId, kind, language)) return;
  mutate(actor, "email_template.reset", (tx, audit) => {
    const existing = tx
      .select()
      .from(emailTemplate)
      .where(
        scoped(userId).where(emailTemplate, (t, { and, eq }) =>
          and(eq(t.kind, kind), eq(t.language, language)),
        ),
      )
      .get();
    if (!existing) return;
    tx.delete(emailTemplate)
      .where(scoped(userId).where(emailTemplate, (t, { eq }) => eq(t.id, existing.id)))
      .run();
    audit({
      entity: "email_template",
      entityId: existing.id,
      ownerId: userId,
      scope: "user",
      before: { kind, language, subject: existing.subject, body: existing.body },
    });
  });
}

// The customer card is the source: the snapshot on the document is a fallback for a deleted
// customer, and the document keeps its old address for printing, not for delivery (R-24).
export function mailRecipients(
  ownerId: string,
  row: { customerId: string | null; customerSnapshot: { email: string } | null },
): string[] {
  const card = row.customerId ? getCustomer(ownerId, row.customerId) : null;
  const addresses = card ? [card.email, ...card.extraEmails] : [row.customerSnapshot?.email ?? ""];
  return addresses.filter((address, i) => address !== "" && addresses.indexOf(address) === i);
}

export function composeMail(
  ownerId: string,
  invoiceId: string,
  kind: MessageKind,
  override?: MailContent,
): MailDraft {
  const doc = loadInvoiceDocument(ownerId, invoiceId);
  if (!doc) throw new ServiceError(E.invoiceNotFound);

  let content: MailContent;
  if (override) {
    const parsed = mailContentSchema.safeParse(override);
    if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
    content = parsed.data;
  } else {
    const template = getEmailTemplate(ownerId, kind, doc.language);
    const base = variablesFor(ownerId, doc, doc.number ?? "", doc.customerName);
    const ctx = { ...base, dateFormat: doc.dateFormat ?? base.dateFormat };
    const extra = {
      castka: formatMoney(doc.totals.totalMinor, doc.currency),
      zbyva: formatMoney(amountDue(doc.totals), doc.currency),
      splatnost: doc.dueDate ? formatCalendarDate(doc.dueDate, ctx.dateFormat) : "",
      vs: doc.variableSymbol ?? "",
      dodavatel: doc.snapshot.supplier?.name ?? "",
    };
    content = {
      subject: capSubject(
        renderVariables(template.subject, ctx, extra).replace(/[\r\n\u0085\u2028\u2029]+/g, " "),
      ),
      body: renderVariables(template.body, ctx, extra),
    };
  }

  const settings = getMailSettings(ownerId);
  return {
    to: mailRecipients(ownerId, {
      customerId: doc.customerId,
      customerSnapshot: doc.snapshot.customer,
    }),
    cc: settings.cc,
    bcc: settings.bcc,
    ...content,
    attachmentName: fileNameFor(getPreferences(ownerId).pdfFileName, doc),
  };
}
