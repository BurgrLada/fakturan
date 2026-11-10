import { expect, test } from "vitest";
import { notificationTarget, notificationText } from "@/lib/notification-text";
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

test("upozornění na doklad nebo plán vede na jeho stránku, odvozené podle druhu", () => {
  expect(notificationTarget("mail_failed", { type: "invoice", id: "f1" })?.href).toBe(
    "/faktury/f1",
  );
  expect(
    notificationTarget("recurring_missed", { type: "recurring_invoice", id: "p1" })?.href,
  ).toBe("/pravidelne/p1");
  expect(notificationTarget("invoices_overdue")?.href).toBe("/faktury?stav=po-splatnosti");
  expect(notificationTarget("bank_connection_failed")?.href).toBe("/nastaveni/aviza");
  expect(notificationTarget("export_ready", { type: "export", id: "e1" })?.href).toBe(
    "/nastaveni/export",
  );
  expect(notificationTarget("mail_failed")).toBeNull();
});
