import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { registerSqlFunctions } from "@/lib/sql-functions";
import * as schema from "@/server/db/schema";
import type { Db } from "@/server/db";
import { assertConsistent } from "../helpers/consistency";
import { startSmtp, type TestSmtp } from "../helpers/smtp";
import { forgetProcess, isFakturanNext, recordProcess } from "./process-registry";

// The name a container reaches a test server on the host by.
export const DOCKER_HOST_NAME = "host.docker.internal";

type App = {
  baseURL: string;
  dataDir: string;
  smtp: TestSmtp | null;
  cnb: { setAvailable: (available: boolean) => void };
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(url: string, child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start skončil s kódem ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Aplikace nenaběhla na ${url}`);
}

// R-23: the server runs as a direct child, so its PID is the server itself and nothing outlives it
// unnoticed; a crashed worker leaves the PID in the registry for globalTeardown.
const NEXT_BIN = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const KILL_AFTER_MS = 5_000;
const servers = new Set<ChildProcess>();
let signalsHandled = false;

function stopServersOnSignal() {
  if (signalsHandled) return;
  signalsHandled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const child of servers) {
        if (child.pid && isFakturanNext(child.pid)) child.kill("SIGTERM");
      }
      // Without another listener, ours would have swallowed the default exit.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
    await exited;
    clearTimeout(timer);
  }
  servers.delete(child);
  if (child.pid) forgetProcess(child.pid);
}

async function waitForContainer(url: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await fetch(url).then(
      (res) => res.ok,
      () => false,
    );
    if (ready) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Kontejner nenaběhl na ${url}`);
}

const ARES_REPLY = {
  ico: "27082440",
  obchodniJmeno: "Alza.cz a.s.",
  dic: "CZ27082440",
  sidlo: {
    nazevStatu: "Česká republika",
    nazevObce: "Praha",
    nazevUlice: "Jankovcova",
    cisloDomovni: 1522,
    cisloOrientacni: 53,
    psc: 17000,
  },
};

// The EUR rate carries the day of the list, so a test can tell which day the form asked for.
const cnbList = (date: string) =>
  [
    `${date} #211`,
    "země|měna|množství|kód|kurz",
    `EMU|euro|1|EUR|24,${date.slice(0, 2)}0`,
    "USA|dolar|1|USD|22,311",
    "",
  ].join("\n");

async function startCnbStub(initiallyAvailable: boolean) {
  let available = initiallyAvailable;
  const server = createHttpServer((request, response) => {
    const date = new URL(request.url!, "http://stub").searchParams.get("date") ?? "30.10.2026";
    response.writeHead(available ? 200 : 503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(available ? cnbList(date) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    setAvailable: (value: boolean) => void (available = value),
  };
}

async function startAresStub() {
  const server = createHttpServer((request, response) => {
    const known = request.url === `/${ARES_REPLY.ico}`;
    response.writeHead(known ? 200 : 404, { "Content-Type": "application/json" });
    response.end(known ? JSON.stringify(ARES_REPLY) : "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function assertDataDirConsistent(dataDir: string) {
  const path = join(dataDir, "fakturan.db");
  if (!existsSync(path)) return;
  const sqlite = new Database(path, { readonly: true });
  registerSqlFunctions(sqlite);
  try {
    const db = drizzle(sqlite, { schema }) as unknown as Db;
    const ids = sqlite.prepare("SELECT id FROM user").pluck().all() as string[];
    for (const id of ids) assertConsistent(db, id);
    if (ids.length === 0) assertConsistent(db, "");
  } finally {
    sqlite.close();
  }
}

export const test = base.extend<{
  freshApp: App;
  dockerApp: { baseURL: string; container: string };
  withSmtp: boolean;
  allowPrivateMail: boolean;
  cnbAvailable: boolean;
  dockerCaFile: string | null;
}>({
  withSmtp: [false, { option: true }],
  allowPrivateMail: [false, { option: true }],
  cnbAvailable: [true, { option: true }],
  // A CA the container trusts on top of the public ones, for a test server with a certificate.
  dockerCaFile: [null, { option: true }],

  dockerApp: async ({ allowPrivateMail, dockerCaFile }, use) => {
    const image = process.env.E2E_DOCKER_IMAGE;
    if (!image) throw new Error("Chybí E2E_DOCKER_IMAGE");
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const container = execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--publish",
        `127.0.0.1:${port}:3000`,
        "--env",
        `BETTER_AUTH_URL=${baseURL}`,
        "--env",
        "BETTER_AUTH_SECRET=e2e-secret-e2e-secret-e2e-secret-00",
        "--env",
        `ENCRYPTION_KEY=${Buffer.alloc(32, 7).toString("base64")}`,
        "--env",
        "SCHEDULER_TICK_SECONDS=1",
        "--env",
        "CNB_BASE_URL=http://127.0.0.1:9",
        ...(allowPrivateMail
          ? [
              "--env",
              "ALLOW_PRIVATE_MAIL_HOSTS=1",
              "--add-host",
              `${DOCKER_HOST_NAME}:host-gateway`,
            ]
          : []),
        ...(dockerCaFile
          ? [
              "--volume",
              `${dockerCaFile}:/etc/fakturan-test-ca.pem:ro`,
              "--env",
              "NODE_EXTRA_CA_CERTS=/etc/fakturan-test-ca.pem",
            ]
          : []),
        image,
      ],
      { encoding: "utf8" },
    ).trim();
    try {
      await waitForContainer(`${baseURL}/api/health`);
      await use({ baseURL, container });
    } finally {
      execFileSync("docker", ["stop", container], { stdio: "ignore" });
    }
  },

  freshApp: async ({ withSmtp, allowPrivateMail, cnbAvailable }, use) => {
    const ares = await startAresStub();
    const cnb = await startCnbStub(cnbAvailable);
    const smtp = withSmtp ? await startSmtp() : null;
    const dataDir = mkdtempSync(join(tmpdir(), "fakturan-e2e-"));
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    stopServersOnSignal();
    const child = spawn(
      process.execPath,
      [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          BETTER_AUTH_URL: baseURL,
          BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-00",
          ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
          ARES_BASE_URL: ares.url,
          CNB_BASE_URL: cnb.url,
          SCHEDULER_TICK_SECONDS: "1",
          ...(allowPrivateMail && { ALLOW_PRIVATE_MAIL_HOSTS: "1" }),
          ...(smtp && {
            SMTP_HOST: "127.0.0.1",
            SMTP_PORT: String(smtp.port),
            SMTP_FROM: "fakturan@example.cz",
          }),
        },
      },
    );
    servers.add(child);
    if (child.pid) recordProcess(child.pid);
    try {
      await waitForReady(baseURL, child);
      await use({ baseURL, dataDir, smtp, cnb });
      assertDataDirConsistent(dataDir);
    } finally {
      await stopServer(child);
      ares.close();
      cnb.close();
      await smtp?.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
});

export { expect };
