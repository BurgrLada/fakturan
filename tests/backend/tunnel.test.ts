import { describe, expect, test, vi } from "vitest";
import { relayEnvelope } from "@/server/monitoring/tunnel";

const DSN = "https://pubkey@errors.example.cz/7";
const envelope = (dsn: string) => `${JSON.stringify({ dsn, sent_at: "x" })}\n{"type":"event"}\n{}`;

describe("monitoring tunnel", () => {
  test("[MON-003] obálka s nakonfigurovaným DSN se přepošle na ingest instance", async () => {
    const send = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await relayEnvelope(envelope(DSN), DSN, send);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      "https://errors.example.cz/api/7/envelope/",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("[MON-003] obálka s cizím DSN se nepřepošle", async () => {
    const send = vi.fn();
    const res = await relayEnvelope(envelope("https://evil@attacker.example/1"), DSN, send);
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  test("[MON-003] bez SENTRY_DSN tunel neexistuje", async () => {
    const send = vi.fn();
    const res = await relayEnvelope(envelope(DSN), undefined, send);
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  test("[MON-003] poškozená nebo příliš velká obálka se odmítne", async () => {
    const send = vi.fn();
    expect((await relayEnvelope("not json\n", DSN, send)).status).toBe(400);
    expect((await relayEnvelope("x".repeat(2_000_000), DSN, send)).status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  test("[MON-003] nedostupný ingest vrátí 502 bez pádu", async () => {
    const send = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await relayEnvelope(envelope(DSN), DSN, send)).status).toBe(502);
  });
});
