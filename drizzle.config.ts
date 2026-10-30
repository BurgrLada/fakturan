import { join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

const dataDir = resolve(process.env.DATA_DIR || "./data");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_PATH || join(dataDir, "fakturan.db") },
});
