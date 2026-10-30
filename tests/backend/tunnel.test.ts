import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { publicDsn, sameDsn } from "@/server/monitoring/dsn";
import { readCapped, relayEnvelope } from "@/server/monitoring/tunnel";
import { RATE_RULES } from "@/server/rate-limit";
import { createTestDb } from "../helpers/db";

const DSN = "https://pubkey@errors.example.cz/7";
const enc = (s: string) => new TextEncoder().encode(s);
const envelope = (dsn: string) =>
  enc(`${JSON.stringify({ dsn, sent_at: "x" })}\n{"type":"event"}\n{}`);

describe("relayEnvelope", () => {
  test("obálka s nakonfigurovaným DSN se přepošle jako bajty s časovým limitem", async () => {
    const send = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
    const res = await relayEnvelope(envelope(DSN), DSN, send);
    expect(res.status).toBe(200);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe("https://errors.example.cz/api/7/envelope/");
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("zachová prefix cesty DSN", async () => {
    const dsn = "https://k@host.example.cz/sentry/9";
    const send = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
    await relayEnvelope(envelope(dsn), dsn, send);
    expect(send.mock.calls[0][0]).toBe("https://host.example.cz/sentry/api/9/envelope/");
  });

  test("cizí host, klíč nebo projekt se nepřepošle", async () => {
    const send = vi.fn();
    for (const bad of [
      "https://evil@attacker.example/1",
      "https://other@errors.example.cz/7",
      "https://pubkey@errors.example.cz/8",
      "https://pubkey@errors.example.cz.evil.example/7",
    ]) {
      expect((await relayEnvelope(envelope(bad), DSN, send)).status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  });

  test("DSN s tajným klíčem se shoduje s veřejnou podobou a tajemství se neprozradí", () => {
    const secret = "https://pubkey:topsecret@errors.example.cz/7";
    expect(publicDsn(secret)).toBe(DSN);
    expect(sameDsn(publicDsn(secret)!, secret)).toBe(true);
  });

  test("bez DSN, poškozená a nedostupná obálka", async () => {
    const send = vi.fn();
    expect((await relayEnvelope(envelope(DSN), undefined, send)).status).toBe(404);
    expect((await relayEnvelope(enc("not json\n"), DSN, send)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await relayEnvelope(envelope(DSN), DSN, down)).status).toBe(502);
  });
});

describe("POST /api/monitoring", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "fakturan-mon-"));
  createTestDb();

  async function post(body: BodyInit, headers: Record<string, string> = {}) {
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("BETTER_AUTH_URL", "https://f.example.cz");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("SENTRY_DSN", DSN);
    vi.doMock("next/server", () => ({ connection: async () => {} }));
    const { POST } = await import("../../src/app/api/monitoring/route");
    return POST(
      new Request("https://f.example.cz/api/monitoring", { method: "POST", body, headers }),
    );
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("příliš velké tělo se odmítne podle Content-Length i při čtení proudu", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const big = new Uint8Array(1_100_000);
    expect((await post(big, { "content-length": String(big.length) })).status).toBe(413);
    expect((await post(big)).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("cizí Origin se odmítne", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post(envelope(DSN), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("zastavené tělo se po časovém limitu odmítne", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(3)) });
      const request = new Request("https://f.example.cz/x", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit);
      const pending = readCapped(request);
      const assertion = expect(pending).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(6000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("platná obálka z vlastního Originu projde a po vyčerpání limitu přijde 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    const ok = await post(envelope(DSN), { origin: "https://f.example.cz" });
    expect(ok.status).toBe(200);
    let last = ok;
    for (let i = 0; i < RATE_RULES.monitoringIp.limit; i++) last = await post(envelope(DSN));
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBeTruthy();
  });
});
