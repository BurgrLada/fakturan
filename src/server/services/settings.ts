import "server-only";
import { eq } from "drizzle-orm";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { user } from "../db/schema";
import { ServiceError } from "./access";
import { mutate } from "./mutation";
import { parseTheme, THEME_CHOICES, type ThemeChoice } from "@/lib/theme";
import { db } from "../db";

export function setTheme(actor: Actor, theme: ThemeChoice): void {
  const userId = actor.userId;
  if (!userId) throw new ServiceError("Na tuto akci nemáte oprávnění");
  if (!THEME_CHOICES.includes(theme)) throw new ServiceError("Neplatný vzhled");
  const current = db.select({ theme: user.theme }).from(user).where(eq(user.id, userId)).get();
  if (!current) throw new ServiceError("Uživatel neexistuje");
  if (parseTheme(current.theme) === theme) return;
  mutate(actor, "user.theme_change", (tx, audit) => {
    tx.update(user).set({ theme, updatedAt: clock.now() }).where(eq(user.id, userId)).run();
    audit({
      entity: "user",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before: { theme: current.theme },
      after: { theme },
    });
  });
}
