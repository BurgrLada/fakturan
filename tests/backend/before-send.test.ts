import { describe, expect, test, vi } from "vitest";
import type { Event } from "@sentry/nextjs";
import { initMonitoring } from "../../sentry.server.config";
import { setMonitoringUser } from "@/server/monitoring/user";
import { scrubEvent } from "@/server/monitoring/before-send";

describe("monitoring", () => {
  test("[MON-001] bez SENTRY_DSN se SDK neinicializuje", () => {
    const sdk = { init: vi.fn() };
    expect(initMonitoring({}, sdk)).toBe(false);
    expect(initMonitoring({ SENTRY_DSN: "" }, sdk)).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
  });

  test("[MON-001] [MON-002] s SENTRY_DSN se SDK inicializuje s prostředím a vzorkováním", () => {
    const sdk = { init: vi.fn() };
    const dsn = "https://key@errors.example.cz/3";
    expect(
      initMonitoring(
        { SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: "staging", SENTRY_TRACES_SAMPLE_RATE: "0.25" },
        sdk,
      ),
    ).toBe(true);
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn,
        environment: "staging",
        tracesSampleRate: 0.25,
        dataCollection: expect.objectContaining({ userInfo: false, cookies: false }),
        beforeSend: scrubEvent,
      }),
    );
  });

  test("[MON-004] scrubEvent odstraní e-mail, IP a zachová ID uživatele", () => {
    const out = scrubEvent({
      user: { id: "u1", email: "a@b.cz", ip_address: "1.2.3.4", username: "adam" },
      request: {
        method: "POST",
        url: "https://f.example.cz/faktury/12?token=abc",
        headers: { cookie: "session=1", authorization: "x" },
        cookies: { session: "1" },
        data: { customer: "Novák" },
        query_string: "token=abc",
      },
      server_name: "host",
      extra: { invoice: { total: 1000 } },
      breadcrumbs: [{ message: "klik na a@b.cz" }],
    });
    expect(out.user).toEqual({ id: "u1" });
    expect(out.request).toEqual({ method: "POST", url: "https://f.example.cz/faktury/12" });
    expect(out.extra).toBeUndefined();
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.server_name).toBeUndefined();
  });

  test("[MON-004] scrubEvent skryje e-mail ve zprávě a token v adrese pozvánky", () => {
    const out = scrubEvent({
      message: "Odeslání na jana@firma.cz selhalo",
      exception: { values: [{ type: "Error", value: "SMTP odmítl jana@firma.cz" }] },
      request: { url: "https://f.example.cz/pozvanka/SECRET123" },
    });
    expect(JSON.stringify(out)).not.toContain("jana@firma.cz");
    expect(JSON.stringify(out)).not.toContain("SECRET123");
  });

  test("[MON-004] událost bez uživatele zůstane bez uživatele", () => {
    expect(scrubEvent({ message: "x" } as Event).user).toBeUndefined();
  });

  test("[MON-004] transakce, kontexty, spany a tagy neprozradí token pozvánky", () => {
    const token = "TOKEN-abc123";
    const out = scrubEvent({
      type: "transaction",
      transaction: `GET /pozvanka/${token}`,
      contexts: {
        trace: { trace_id: "t", span_id: "s", data: { "url.full": `/pozvanka/${token}` } },
        runtime: { name: "node" },
        response: { headers: { location: `/pozvanka/${token}` } },
      },
      spans: [
        {
          span_id: "a",
          trace_id: "t",
          start_timestamp: 1,
          data: { "http.url": `https://f.cz/pozvanka/${token}?e=a@b.cz` },
          description: `GET /pozvanka/${token}`,
        },
      ],
      tags: { invitee: "a@b.cz" },
      breadcrumbs: [{ data: { url: `/pozvanka/${token}` } }],
      request: { url: `https://f.cz/pozvanka/${token}` },
      exception: {
        values: [
          {
            type: "Error",
            value: `bad /pozvanka/${token}`,
            stacktrace: { frames: [{ filename: "a.js", vars: { password: "hunter2" } }] },
          },
        ],
      },
    } as unknown as Event);
    const json = JSON.stringify(out);
    expect(json).not.toContain(token);
    expect(json).not.toContain("a@b.cz");
    expect(json).not.toContain("hunter2");
    expect(out.spans).toBeUndefined();
    expect(out.tags).toBeUndefined();
    expect(out.contexts).toEqual({ trace: expect.objectContaining({ trace_id: "t" }) });
    expect(out.transaction).toBe("GET /pozvanka/[token]");
  });

  test("[MON-004] allowlist zachová identitu události", () => {
    const out = scrubEvent({
      event_id: "e",
      level: "error",
      platform: "node",
      environment: "prod",
      release: "1",
      unknown_field: "x",
    } as Event);
    expect(out).toEqual({
      event_id: "e",
      level: "error",
      platform: "node",
      environment: "prod",
      release: "1",
    });
  });

  test("[MON-004] beforeSendTransaction je také scrubEvent", () => {
    const sdk = { init: vi.fn() };
    initMonitoring({ SENTRY_DSN: "https://k@h.example.cz/1" }, sdk);
    expect(sdk.init.mock.calls[0][0].beforeSendTransaction).toBe(scrubEvent);
  });

  test("[MON-004] do SDK se nastavuje jen ID uživatele", async () => {
    const setUser = vi.fn();
    await setMonitoringUser("u1", "https://k@h.example.cz/1", async () => ({ setUser }));
    expect(setUser).toHaveBeenCalledWith({ id: "u1" });
    const idle = vi.fn(async () => ({ setUser }));
    await setMonitoringUser("u2", undefined, idle);
    expect(idle).not.toHaveBeenCalled();
  });
});
