import { z } from "zod";
import { TEXTS } from "./texts";

const E = TEXTS.bankMailbox.errors;

export const BANK_TLS_MODES = ["implicit", "starttls"] as const;
export type BankTlsMode = (typeof BANK_TLS_MODES)[number];

export const BANK_FAILURE_CODES = [
  "auth",
  "blocked_host",
  "timeout",
  "tls",
  "folder",
  "decrypt",
  "other",
] as const;
export type BankFailureCode = (typeof BANK_FAILURE_CODES)[number];

export const DEFAULT_BANK_FOLDER = "INBOX";

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max, E.invalid)
    .regex(/^[^\r\n]*$/, E.singleLine);

export const bankMailboxSchema = z.object({
  host: line(253).min(1, E.host),
  port: z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, E.port)
    .transform(Number)
    .refine((value) => value >= 1 && value <= 65535, E.port),
  tls: z.enum(BANK_TLS_MODES, E.tls),
  username: line(320).min(1, E.username),
  password: z
    .string()
    .max(1024, E.invalid)
    .regex(/^[^\r\n]*$/, E.singleLine),
  folder: line(255).transform((value) => value || DEFAULT_BANK_FOLDER),
  enabled: z.boolean(),
  requireConfirmation: z.boolean(),
  authServId: line(255)
    .regex(/^[^\s;()"]*$/, E.authServId)
    .transform((value) => value.toLowerCase())
    .default(""),
});

export type BankMailboxInput = z.input<typeof bankMailboxSchema>;
