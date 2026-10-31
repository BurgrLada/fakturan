import { z } from "zod";
import type { InvoiceType } from "./invoice";
import { LANGUAGES } from "./preferences";
import { TEXTS } from "./texts";
import { MAIL_VARIABLE_NAMES, validateVariables } from "./template-vars";

const E = TEXTS.emailTemplates.errors;

export const MESSAGE_KINDS = [
  "invoice",
  "advance",
  "credit_note",
  "reminder",
  "payment_receipt",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 10_000;

export function kindForInvoice(type: InvoiceType): MessageKind {
  return type;
}

const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

const subject = z
  .string(E.invalid)
  .trim()
  .min(1, E.subjectRequired)
  .max(MAX_SUBJECT_CHARS, E.subjectTooLong)
  .refine((value) => !LINE_BREAK.test(value), E.subjectLineBreak);

const body = z
  .string(E.invalid)
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(z.string().min(1, E.bodyRequired).max(MAX_BODY_CHARS, E.bodyTooLong));

export const mailContentSchema = z.object({ subject, body });

export const emailTemplateSchema = z
  .object({
    kind: z.enum(MESSAGE_KINDS, E.invalid),
    language: z.enum(LANGUAGES, E.invalid),
    subject,
    body,
  })
  .superRefine((value, ctx) => {
    const unknown = validateVariables(`${value.subject}\n${value.body}`, MAIL_VARIABLE_NAMES);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `${E.unknownVariable}: ${unknown.map((name) => `{{${name}}}`).join(", ")}`,
      });
    }
  });

export type EmailTemplateInput = z.input<typeof emailTemplateSchema>;
