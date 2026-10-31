import { z } from "zod";
import { MAX_DOCUMENT_MINOR } from "./invoice-totals";
import { TEXTS } from "./texts";

const E = TEXTS.bankQueue.errors;

export const MAX_SPLIT_PARTS = 10;

const id = z.string(E.invalid).min(1, E.invalid);
const minor = z
  .number(E.invalid)
  .int(E.invalid)
  .min(1, E.invalid)
  .max(MAX_DOCUMENT_MINOR, E.invalid);

export const assignInputSchema = z.object(
  { invoiceId: id, creditedMinor: minor.nullish() },
  E.invalid,
);
export type AssignInput = z.input<typeof assignInputSchema>;

export const splitInputSchema = z.object(
  {
    parts: z
      .array(
        z.object({ invoiceId: id, amountMinor: minor, creditedMinor: minor.nullish() }),
        E.invalid,
      )
      .min(2, E.splitFew)
      .max(MAX_SPLIT_PARTS, E.splitMany),
  },
  E.invalid,
);
export type SplitInput = z.input<typeof splitInputSchema>;

export const NOTICE_VIEWS = ["queue", "unrecognized", "history"] as const;
export type NoticeView = (typeof NOTICE_VIEWS)[number];
