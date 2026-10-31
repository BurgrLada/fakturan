// Drains the real queue in a separate process and SIGKILLs itself at the point named by CRASH_AT.
import { existsSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stub = pathToFileURL(join(root, "tests/helpers/server-only.ts")).href;
// The designs are JSX, which Node's type stripping cannot load: the test archives the PDF up front.
const designsStub = pathToFileURL(join(root, "tests/helpers/designs-stub.ts")).href;

const MAILER = "crash:nodemailer";

function withExtension(path) {
  if (existsSync(`${path}.ts`)) return `${path}.ts`;
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "index.ts") : path;
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: stub, shortCircuit: true };
    if (specifier === "nodemailer" && context.parentURL?.includes("/src/")) {
      return { url: MAILER, shortCircuit: true };
    }
    if (/\/(pdf\/)?(designs|render)$/.test(specifier) && !specifier.startsWith("/")) {
      return { url: designsStub, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const path = withExtension(join(root, "src", specifier.slice(2)));
      return { url: pathToFileURL(path).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/")) {
      const path = withExtension(join(dirname(fileURLToPath(context.parentURL)), specifier));
      return { url: pathToFileURL(path).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== MAILER) return next(url, context);
    const source = "export const createTransport = globalThis.crashTransport;";
    return { format: "module", source, shortCircuit: true };
  },
});

const { CRASH_AT: killAt, CRASH_DATABASE_PATH: databasePath, CRASH_NOW: now } = process.env;
const die = () => process.kill(process.pid, "SIGKILL");

const { createTransport } = createRequire(import.meta.url)("nodemailer");
globalThis.crashTransport = (...args) => {
  const transport = createTransport(...args);
  return {
    async sendMail(message) {
      if (killAt === "after_sending") die();
      const info = await transport.sendMail(message);
      if (killAt === "after_smtp") die();
      return info;
    },
  };
};

const { setClockForTests } = await import("@/server/clock");
const { createDb, setDbForTests } = await import("@/server/db");
const { registerJob } = await import("@/server/jobs/registry");
const { drainJobs } = await import("@/server/jobs/worker");
const { deliverMail, recoverMail } = await import("@/server/services/mail-delivery");
const { runRecurringJob } = await import("@/server/services/recurring-run");

const db = createDb(databasePath);
setDbForTests(db);
setClockForTests({ now: () => new Date(now) });
registerJob("mail.send", { run: deliverMail, recover: recoverMail });
registerJob("recurring.run", { run: runRecurringJob });

if (killAt === "in_run_tx") {
  // Fires once the number is taken, inside the transaction of the run.
  db.$client.function("crash_now", () => die());
  db.$client.exec(`CREATE TEMP TRIGGER crash_in_run AFTER UPDATE OF number ON main.invoice
    WHEN new.number IS NOT NULL BEGIN SELECT crash_now(); END`);
}

await drainJobs("mrtvy-proces");
process.exitCode = 1;
console.error("Fronta doběhla bez pádu");
