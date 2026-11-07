import "server-only";
import { env as defaultEnv, type Env } from "../env";
import { buildTransport, type SmtpTarget } from "./transport";

export type InstanceMail = { to: string; subject: string; text: string };

// A demo never sends, so the auth mails (verification, reset) stay off there too (OPS-007).
export function isInstanceMailConfigured(env: Env = defaultEnv): boolean {
  if (env.DEMO_MODE) return false;
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM);
}

export function instanceTarget(env: Env = defaultEnv): SmtpTarget {
  if (!env.SMTP_HOST || !env.SMTP_PORT) throw new Error("Instance nemá nastavené SMTP");
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  };
}

export async function sendInstanceMail(msg: InstanceMail, env: Env = defaultEnv): Promise<void> {
  if (!isInstanceMailConfigured(env)) throw new Error("Instance nemá nastavené SMTP");
  await buildTransport(instanceTarget(env)).sendMail({ from: env.SMTP_FROM, ...msg });
}
