import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { lookupVies, splitVatId } from "@/server/external/vies";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-vies-")));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("VIES", () => {
  test("[CUS-005] DIČ se rozdělí na kód země a číslo", () => {
    expect(splitVatId("CZ27082440")).toEqual({ country: "CZ", number: "27082440" });
    expect(splitVatId("de 811 128 135")).toEqual({ country: "DE", number: "811128135" });
    expect(splitVatId("27082440")).toBeNull();
    expect(splitVatId("")).toBeNull();
    expect(splitVatId("CZ")).toBeNull();
  });

  test("[CUS-005] platné DIČ se ověří na adrese z konfigurace", async () => {
    const fetcher = vi.fn(async (_url: string) => json({ isValid: true }));

    await expect(lookupVies("CZ27082440", fetcher)).resolves.toBe("valid");

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/CZ/vat/27082440",
    );
  });

  test("[CUS-005] neplatné DIČ vrátí invalid", async () => {
    await expect(lookupVies("CZ27082440", async () => json({ isValid: false }))).resolves.toBe(
      "invalid",
    );
  });

  test("[CUS-005] výpadek, chyba služby i nesmyslná odpověď znamenají nedostupné", async () => {
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(lookupVies("CZ27082440", down)).resolves.toBe("unavailable");
    await expect(lookupVies("CZ27082440", async () => json({}, 503))).resolves.toBe("unavailable");
    await expect(
      lookupVies("CZ27082440", async () => json({ isValid: false, userError: "MS_UNAVAILABLE" })),
    ).resolves.toBe("unavailable");
    await expect(lookupVies("CZ27082440", async () => json({ nic: 1 }))).resolves.toBe(
      "unavailable",
    );
    await expect(lookupVies("neni-dic", down)).resolves.toBe("unavailable");
  });

  test("[CUS-005] pomalá odpověď se po vypršení limitu přeruší", async () => {
    vi.useFakeTimers();
    try {
      const hang = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const result = lookupVies("CZ27082440", hang);
      await vi.advanceTimersByTimeAsync(5_001);
      await expect(result).resolves.toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });
});
