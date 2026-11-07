import { z } from "zod";
import { TEXTS } from "./texts";

export const MAIL_LAYOUTS = ["b1", "b2", "b3", "b4", "b5", "a", "c"] as const;
export type MailLayout = (typeof MAIL_LAYOUTS)[number];
export const DEFAULT_MAIL_LAYOUT: MailLayout = "b4";
export const LAYOUTS_WITH_QR: readonly MailLayout[] = ["b2", "b3", "b5"];

export const MAIL_LOGO_MODES = ["supplier", "custom", "none"] as const;
export type MailLogoMode = (typeof MAIL_LOGO_MODES)[number];

export const MAIL_LOOK_TEXT_MAX = 2_000;

export function isMailLayout(value: string): value is MailLayout {
  return (MAIL_LAYOUTS as readonly string[]).includes(value);
}

const E = TEXTS.mailLook.errors;

// Blank means none: the default templates already sign off with the supplier (R-19 note).
const optionalText = z
  .string(E.invalid)
  .max(MAIL_LOOK_TEXT_MAX, E.tooLong)
  .transform((value) => (value.trim() === "" ? null : value.replace(/\r\n?/g, "\n")));

export const mailLookSchema = z.strictObject(
  {
    layout: z.enum(MAIL_LAYOUTS, E.invalid),
    intro: optionalText,
    signature: optionalText,
    logoMode: z.enum(MAIL_LOGO_MODES, E.invalid),
  },
  E.invalid,
);

export type MailLookInput = z.input<typeof mailLookSchema>;

// The logo and the payment code: all an HTML message ever embeds.
export const MAX_HTML_IMAGES = 2;
