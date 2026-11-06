import { z } from "zod";
import { TEXTS } from "./texts";

const E = TEXTS.mailSettings.errors;

const MAX_COPIES = 10;

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max, E.invalid)
    .regex(/^[^\r\n]*$/, E.singleLine);

const optionalEmail = (message: string) =>
  z
    .string()
    .trim()
    .max(254, message)
    .refine((value) => value === "" || z.email().safeParse(value).success, message);

export function splitAddresses(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const addressList = z
  .string()
  .transform(splitAddresses)
  .refine(
    (items) =>
      items.length <= MAX_COPIES && items.every((item) => z.email().safeParse(item).success),
    E.list,
  );

const port = z
  .string()
  .trim()
  .refine((value) => value === "" || /^\d{1,5}$/.test(value), E.port)
  .transform((value) => (value === "" ? null : Number(value)))
  .refine((value) => value === null || (value >= 1 && value <= 65535), E.port);

export const mailSettingsSchema = z
  .object({
    smtpHost: line(253),
    smtpPort: port,
    smtpUser: line(320),
    smtpPassword: z
      .string()
      .max(1024, E.invalid)
      .regex(/^[^\r\n]*$/, E.singleLine),
    fromEmail: optionalEmail(E.fromEmail),
    senderName: line(200),
    replyTo: optionalEmail(E.replyTo),
    cc: addressList,
    bcc: addressList,
  })
  .superRefine((value, ctx) => {
    if (!value.smtpHost) return;
    if (value.smtpPort === null) ctx.addIssue({ code: "custom", message: E.port });
    if (!value.fromEmail) ctx.addIssue({ code: "custom", message: E.fromEmail });
  });

export type MailSettingsInput = z.input<typeof mailSettingsSchema>;
