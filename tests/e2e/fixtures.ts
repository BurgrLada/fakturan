import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/server/db/schema";
import type { Db } from "@/server/db";
import { assertConsistent } from "../helpers/consistency";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

type App = { baseURL: string; dataDir: string; smtp: TestSmtp | null };

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
  dockerApp: { baseURL: string };
  withSmtp: boolean;
}>({
  withSmtp: [false, { option: true }],

  // oxlint-disable-next-line no-empty-pattern
  dockerApp: async ({}, use) => {
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
        image,
      ],
      { encoding: "utf8" },
    ).trim();
    try {
      await waitForContainer(`${baseURL}/api/health`);
      await use({ baseURL });
    } finally {
      execFileSync("docker", ["stop", container], { stdio: "ignore" });
    }
  },

  freshApp: async ({ withSmtp }, use) => {
    const ares = await startAresStub();
    const smtp = withSmtp ? await startSmtp() : null;
    const dataDir = mkdtempSync(join(tmpdir(), "fakturan-e2e-"));
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const child = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", "127.0.0.1"], {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        BETTER_AUTH_URL: baseURL,
        BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-00",
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        ARES_BASE_URL: ares.url,
        SCHEDULER_TICK_SECONDS: "1",
        ...(smtp && {
          SMTP_HOST: "127.0.0.1",
          SMTP_PORT: String(smtp.port),
          SMTP_FROM: "fakturan@example.cz",
        }),
      },
    });
    try {
      await waitForReady(baseURL, child);
      await use({ baseURL, dataDir, smtp });
      assertDataDirConsistent(dataDir);
    } finally {
      process.kill(-child.pid!, "SIGTERM");
      ares.close();
      await smtp?.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
});

export { expect };
