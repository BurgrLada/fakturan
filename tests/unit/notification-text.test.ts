import { expect, test } from "vitest";
import { notificationText } from "@/lib/notification-text";
import type { NotificationKind } from "@/lib/automation";
import { TEXTS } from "@/lib/texts";

test("neznámý druh ze staršího nebo novějšího řádku stránku neshodí", () => {
  const stored = "zrusena_udalost" as NotificationKind;
  expect(notificationText(stored, {})).toBe(TEXTS.notifications.unknownKind);
  expect(notificationText("mail_failed", { invoice: "2026001" })).toContain("2026001");
});

test("[UI-011] upozornění na limit nese procento, částky a upozorňuje, že jde o podklad", () => {
  const text = notificationText("turnover_limit", {
    limit: "vat",
    year: 2026,
    percent: 95,
    turnover: "1 900 000,00 Kč",
    limitAmount: "2 000 000,00 Kč",
    over: false,
  });

  expect(text).toContain("95 %");
  expect(text).toContain("registraci k DPH");
  expect(text).toContain("1 900 000,00 Kč");
  expect(notificationText("turnover_limit", { limit: "flat", over: true })).toContain("překročený");
});
