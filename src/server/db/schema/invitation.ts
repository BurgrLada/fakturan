import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const invitation = sqliteTable(
  "invitation",
  {
    id: text().primaryKey(),
    email: text().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    role: text({ enum: ["admin", "user"] }).notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    // No foreign key: it is written before Better Auth inserts the user.
    acceptedUserId: text("accepted_user_id"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("invitation_email_idx").on(t.email)],
);
