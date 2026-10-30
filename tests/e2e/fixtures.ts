import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";

type App = { baseURL: string; dataDir: string };

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

export const test = base.extend<{ freshApp: App }>({
  // oxlint-disable-next-line no-empty-pattern
  freshApp: async ({}, use) => {
    const dataDir = mkdtempSync(join(tmpdir(), "fakturan-e2e-"));
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        BETTER_AUTH_URL: baseURL,
        BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-00",
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
    });
    try {
      await waitForReady(baseURL, child);
      await use({ baseURL, dataDir });
    } finally {
      process.kill(-child.pid!, "SIGTERM");
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
});

export { expect };
