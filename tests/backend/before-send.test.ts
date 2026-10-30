import { describe, expect, test, vi } from "vitest";
import type { Event } from "@sentry/nextjs";
import { initMonitoring } from "../../sentry.server.config";
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
});
