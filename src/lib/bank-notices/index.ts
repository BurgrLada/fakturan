import { fioParser } from "./fio";
import type { BankNoticeParser, NoticeKind, NoticeMeta, NoticeVariant } from "./types";

export function assertVariantIds(parsers: readonly BankNoticeParser[]): void {
  const seen = new Set<NoticeVariant>();
  for (const { bank, variants, autoMatchVariants } of parsers) {
    for (const variant of variants) {
      if (seen.has(variant)) throw new Error(`Varianta ${variant} (${bank}) už existuje`);
      seen.add(variant);
    }
    for (const variant of autoMatchVariants) {
      if (!variants.includes(variant)) throw new Error(`Neznámá varianta ${variant} (${bank})`);
    }
  }
}

export const BANK_PARSERS: readonly BankNoticeParser[] = [fioParser];
assertVariantIds(BANK_PARSERS);

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
