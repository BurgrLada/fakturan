import "server-only";
import { createTransport } from "nodemailer";
import { env as defaultEnv, type Env } from "../env";

export type InstanceMail = { to: string; subject: string; text: string };

export function isInstanceMailConfigured(env: Env = defaultEnv): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM);
}

export async function sendInstanceMail(msg: InstanceMail, env: Env = defaultEnv): Promise<void> {
  if (!isInstanceMailConfigured(env)) throw new Error("Instance nemá nastavené SMTP");
  const transport = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  await transport.sendMail({ from: env.SMTP_FROM, ...msg });
}
