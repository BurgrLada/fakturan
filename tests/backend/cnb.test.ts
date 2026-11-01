import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchDailyRates } from "@/server/external/cnb";
import { cnbMode, startCnbStub } from "../helpers/cnb";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-cnb-")));

const stub = await startCnbStub();
vi.stubEnv("CNB_BASE_URL", `${stub.url}/`);
afterAll(() => stub.close());
beforeEach(() => {
  stub.setMode(cnbMode.ok);
  stub.requests.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const text = (body: string, init?: ResponseInit) => new Response(body, init);
const LIST = "30.10.2026 #211\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n";

describe("klient ČNB", () => {
  test("[FOR-004] stáhne lístek ze stejného dne a dotaz nese datum ve tvaru DD.MM.RRRR", async () => {
    const parsed = await fetchDailyRates("2026-10-30");

    expect(parsed?.listDate).toBe("2026-10-30");
    expect(parsed?.rates.find((item) => item.currency === "EUR")?.rateMicros).toBe(24_380_000);
    expect(stub.requests).toEqual(["/denni_kurz.txt?date=30.10.2026"]);
  });

  test("[FOR-003] lístek z pátku pro sobotní dotaz projde, lístek po žádaném dni se zahodí", async () => {
    stub.setMode(cnbMode.date("2026-10-30"));
    expect((await fetchDailyRates("2026-10-31"))?.listDate).toBe("2026-10-30");
    stub.setMode(cnbMode.date("2026-11-03"));
    expect(await fetchDailyRates("2026-10-31")).toBeNull();
    stub.setMode(cnbMode.date("2026-10-31"));
    expect((await fetchDailyRates("2026-10-31"))?.listDate).toBe("2026-10-31");
  });

  test("[FOR-004] HTTP 500, nesmysl a odpověď nad 64 KiB vrátí null", async () => {
    stub.setMode(cnbMode.down);
    expect(await fetchDailyRates("2026-10-30")).toBeNull();
    stub.setMode(cnbMode.garbage);
    expect(await fetchDailyRates("2026-10-30")).toBeNull();
    stub.setMode(cnbMode.big);
    expect(await fetchDailyRates("2026-10-30")).toBeNull();
  });

  test("[FOR-004] odpověď nad 64 KiB bez hlavičky délky se přeruší za pochodu", async () => {
    const chunk = new Uint8Array(40 * 1024).fill(120);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });

    expect(await fetchDailyRates("2026-10-30", async () => text(body as never))).toBeNull();
    expect(sent).toBeLessThan(4);
  });

  test("[FOR-004] přesně 64 KiB se ještě přečte, o bajt víc ne, a hlavička délky nad limit odmítne hned", async () => {
    const limit = 64 * 1024;
    const sized = (size: number) => {
      let out = LIST;
      for (let i = 0; size - Buffer.byteLength(out) > 150; i += 1) {
        const code = String.fromCharCode(
          65 + (i % 26),
          65 + (Math.floor(i / 26) % 26),
          65 + Math.floor(i / 676),
        );
        out += `Zeme|mena|1|${code}|1,000\n`;
      }
      const last = "|mena|1|ZZZ|1,000\n";
      return `${out}${"x".repeat(size - Buffer.byteLength(out) - last.length)}${last}`;
    };
    expect(Buffer.byteLength(sized(limit))).toBe(limit);

    expect((await fetchDailyRates("2026-10-30", async () => text(sized(limit))))?.listDate).toBe(
      "2026-10-30",
    );
    expect(await fetchDailyRates("2026-10-30", async () => text(sized(limit + 1)))).toBeNull();

    const declared = async () => text(LIST, { headers: { "content-length": String(limit + 1) } });
    expect(await fetchDailyRates("2026-10-30", declared)).toBeNull();
    expect((await fetchDailyRates("2026-10-30", async () => text(LIST)))?.rates).toHaveLength(1);
  });

  test("[FOR-004] odpověď bez těla a výjimka fetcheru nevyhodí", async () => {
    expect(await fetchDailyRates("2026-10-30", async () => new Response(null))).toBeNull();
    expect(
      await fetchDailyRates("2026-10-30", async () => {
        throw new Error("síť");
      }),
    ).toBeNull();
  });

  test("[FOR-004] timeout po 5 s vrátí null", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = fetchDailyRates("2026-10-30", fetcher);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toBeNull();
  });

  test("[OPS-003] adresa se bere z konfigurace a koncové lomítko se ořízne", async () => {
    const fetcher = vi.fn(async (_url: string) => text(LIST));
    await fetchDailyRates("2026-01-05", fetcher);
    expect(fetcher.mock.calls[0]![0]).toBe(`${stub.url}/denni_kurz.txt?date=05.01.2026`);
  });
});
