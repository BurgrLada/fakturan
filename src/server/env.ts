import "server-only";
import { accessSync, constants, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const optional = z.string().min(1).optional();
const flag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    DATA_DIR: z.string().min(1).default("./data"),
    DATABASE_PATH: optional,
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        "není platné base64",
      )
      .transform((v) => Buffer.from(v, "base64"))
      .refine((b) => b.length === 32, "musí být 32 bajtů v base64"),
    SMTP_HOST: optional,
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: optional,
    SMTP_PASSWORD: optional,
    SMTP_FROM: optional,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    MICROSOFT_CLIENT_ID: optional,
    MICROSOFT_CLIENT_SECRET: optional,
    APPLE_CLIENT_ID: optional,
    APPLE_TEAM_ID: optional,
    APPLE_KEY_ID: optional,
    APPLE_PRIVATE_KEY: optional,
    SENTRY_DSN: optional,
    SENTRY_ENVIRONMENT: optional,
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
    ARES_BASE_URL: z
      .url()
      .default("https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty")
      .transform((v) => v.replace(/\/+$/, "")),
    CNB_BASE_URL: z
      .url()
      .default("https://www.cnb.cz/cs/financni_trhy/devizovy_trh/kurzy_devizoveho_trhu")
      .transform((v) => v.replace(/\/+$/, "")),
    VIES_BASE_URL: z
      .url()
      .default("https://ec.europa.eu/taxation_customs/vies/rest-api")
      .transform((v) => v.replace(/\/+$/, "")),
    ALLOW_PRIVATE_MAIL_HOSTS: flag,
    TRUST_PROXY: flag,
    SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(1).max(60).default(60),
    DEMO_MODE: flag,
    DEMO_EMAIL: z.email().optional(),
    DEMO_PASSWORD: optional,
  })
  .superRefine((value, ctx) => {
    if (!value.DEMO_MODE) return;
    for (const key of ["DEMO_EMAIL", "DEMO_PASSWORD"] as const) {
      if (!value[key])
        ctx.addIssue({ code: "custom", path: [key], message: "je povinné s DEMO_MODE" });
    }
  });

export type Env = Omit<z.output<typeof schema>, "DATABASE_PATH"> & { DATABASE_PATH: string };

export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Neplatná konfigurace prostředí:\n${lines.join("\n")}`);
  }
  const dataDir = resolve(result.data.DATA_DIR);
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
  } catch (cause) {
    throw new Error(`Složka dat není zapisovatelná: ${dataDir}`, { cause });
  }
  return {
    ...result.data,
    DATA_DIR: dataDir,
    DATABASE_PATH: result.data.DATABASE_PATH ?? join(dataDir, "fakturan.db"),
  };
}

let cached: Env | undefined;

// Lazy, so `next build` does not need secrets.
export const env: Env = new Proxy({} as Env, {
  get(_, prop) {
    cached ??= parseEnv(process.env);
    return cached[prop as keyof Env];
  },
});
