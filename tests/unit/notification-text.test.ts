import { expect, test } from "vitest";
import { notificationText } from "@/lib/notification-text";
import type { NotificationKind } from "@/lib/automation";
import { TEXTS } from "@/lib/texts";

test("neznámý druh ze staršího nebo novějšího řádku stránku neshodí", () => {
  const stored = "zrusena_udalost" as NotificationKind;
  expect(notificationText(stored, {})).toBe(TEXTS.notifications.unknownKind);
  expect(notificationText("mail_failed", { invoice: "2026001" })).toContain("2026001");
});
