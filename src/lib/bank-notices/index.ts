import { fioParser } from "./fio";
import type { BankNoticeParser, NoticeKind, NoticeMeta, NoticeVariant } from "./types";

export const BANK_PARSERS: readonly BankNoticeParser[] = [fioParser];

export const AUTO_MATCH_VARIANTS: readonly NoticeVariant[] = BANK_PARSERS.flatMap(
  (parser) => parser.autoMatchVariants,
);

export function isProvisional(variant: NoticeVariant): boolean {
  return !AUTO_MATCH_VARIANTS.includes(variant);
}

export function parserFor(
  meta: NoticeMeta,
  parsers: readonly BankNoticeParser[] = BANK_PARSERS,
): { parser: BankNoticeParser; kind: NoticeKind } | null {
  for (const parser of parsers) {
    const kind = parser.classify(meta);
    if (kind) return { parser, kind };
  }
  return null;
}
