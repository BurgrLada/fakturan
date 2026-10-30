import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { lookupAresAction } from "@/app/(app)/nastaveni/dodavatel/actions";
import { lookupAres } from "@/server/external/ares";
import { createTestDb } from "../helpers/db";

vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({}),
  actorFromRequest: async () => ({ userId: "u1", source: "web" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-ares-")));

createTestDb();
afterEach(() => vi.unstubAllGlobals());

const REPLY = {
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ARES", () => {
  test("[CUS-004] IČO se předvyplní z odpovědi ARES", async () => {
    const fetcher = vi.fn(async (_url: string) => json(REPLY));

    const result = await lookupAres("27082440", fetcher);

    expect(result).toEqual({
      ico: "27082440",
      name: "Alza.cz a.s.",
      dic: "CZ27082440",
      street: "Jankovcova 1522/53",
      city: "Praha",
      zip: "170 00",
      country: "Česká republika",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/27082440",
    );
  });

  test("[CUS-004] ARES timeout vrátí null", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = lookupAres("27082440", fetcher);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toBeNull();
    vi.useRealTimers();
  });

  test("[CUS-004] nenalezené IČO, chyba serveru a nesmyslné IČO vrátí null", async () => {
    expect(await lookupAres("27082440", async () => json({}, 404))).toBeNull();
    expect(await lookupAres("27082440", async () => json({}, 503))).toBeNull();
    expect(
      await lookupAres("27082440", async () => {
        throw new Error("síť");
      }),
    ).toBeNull();
    const never = vi.fn();
    expect(await lookupAres("12345678", never)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  test("[CUS-004] adresa bez ulice použije část obce a číslo domu", async () => {
    const reply = {
      ...REPLY,
      sidlo: { nazevObce: "Lhota", nazevCastiObce: "Malá Lhota", cisloDomovni: 12, psc: 12345 },
    };

    const result = await lookupAres("27082440", async () => json(reply));

    expect(result?.street).toBe("Malá Lhota 12");
  });
});

describe("ARES akce", () => {
  test("[CUS-004] vyhledávání v ARES je omezené na 30 dotazů za minutu na uživatele", async () => {
    const fetcher = vi.fn(async () => json(REPLY));
    vi.stubGlobal("fetch", fetcher);

    const results = [];
    for (let i = 0; i < 31; i += 1) results.push(await lookupAresAction({ ico: "27082440" }));

    expect(results.slice(0, 30).every((r) => r.ok)).toBe(true);
    expect(results[30]).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledTimes(30);
  });
});
