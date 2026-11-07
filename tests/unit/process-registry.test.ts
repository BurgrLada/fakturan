import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  forgetProcess,
  isFakturanNext,
  reapRecorded,
  recordProcess,
} from "../e2e/process-registry";

const children: ChildProcess[] = [];
const dirs: string[] = [];

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode ?? child.exitCode);
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
}

function registry(): string {
  const dir = mkdtempSync(join(tmpdir(), "fakturan-pids-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("registr procesů e2e", () => {
  test("[TST-004] reapRecorded ukončí jen zapsané procesy, které jsou náš next", async () => {
    const dir = registry();
    const ours = sleeper();
    const recordedForeign = sleeper();
    const unrecorded = sleeper();
    recordProcess(ours.pid!, dir);
    recordProcess(recordedForeign.pid!, dir);

    const reaped = reapRecorded(dir, (pid) => pid === ours.pid || pid === unrecorded.pid);

    expect(reaped).toEqual([ours.pid]);
    expect(await exited(ours)).toBe("SIGTERM");
    expect(recordedForeign.exitCode).toBeNull();
    expect(unrecorded.exitCode).toBeNull();
    expect(process.kill(recordedForeign.pid!, 0)).toBe(true);
    expect(process.kill(unrecorded.pid!, 0)).toBe(true);
  });

  test("[TST-004] cizí PID v registru se neukončí a zápis se smaže", () => {
    const dir = registry();
    const foreign = sleeper();
    recordProcess(foreign.pid!, dir);
    writeFileSync(join(dir, "neni-pid"), "");
    recordProcess(2_147_483_000, dir);

    expect(reapRecorded(dir, () => false)).toEqual([]);
    expect(process.kill(foreign.pid!, 0)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("[TST-004] forgetProcess smaže zápis a chybějící registr nevadí", () => {
    const dir = registry();
    recordProcess(4242, dir);
    expect(existsSync(join(dir, "4242"))).toBe(true);
    forgetProcess(4242, dir);
    expect(existsSync(join(dir, "4242"))).toBe(false);
    forgetProcess(4242, dir);
    expect(reapRecorded(join(dir, "chybi"), () => true)).toEqual([]);
  });

  test("[TST-004] isFakturanNext chce next v příkazu a DATA_DIR z fixture", () => {
    const proc = registry();
    const fake = (pid: number, cmdline: string[], environ: string[]) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "cmdline"), `${cmdline.join("\0")}\0`);
      writeFileSync(join(proc, String(pid), "environ"), `${environ.join("\0")}\0`);
    };
    const next = ["/usr/bin/node", "/repo/node_modules/next/dist/bin/next", "start"];
    fake(1, next, ["PATH=/bin", "DATA_DIR=/tmp/fakturan-e2e-abc123"]);
    fake(2, next, ["DATA_DIR=/srv/fakturan/data"]);
    fake(3, ["/usr/bin/node", "server.js"], ["DATA_DIR=/tmp/fakturan-e2e-abc123"]);
    fake(4, next, ["XDATA_DIR=/tmp/fakturan-e2e-x"]);

    expect(isFakturanNext(1, proc)).toBe(true);
    expect(isFakturanNext(2, proc)).toBe(false);
    expect(isFakturanNext(3, proc)).toBe(false);
    expect(isFakturanNext(4, proc)).toBe(false);
    expect(isFakturanNext(5, proc)).toBe(false);
    expect(isFakturanNext(process.pid)).toBe(false);
  });
});
