import { afterEach, describe, expect, test, vi } from "vitest";

const init = vi.fn();
const setUser = vi.fn();
vi.mock("@sentry/nextjs", () => ({ init, setUser, captureException: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  init.mockClear();
  setUser.mockClear();
});

describe("monitoring client", () => {
  test("[MON-001] bez DSN (404) se klientské SDK neinicializuje", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const { monitoring, identifyClientUser } = await import("@/lib/monitoring-client");
    expect(await monitoring()).toBeNull();
    identifyClientUser("u1");
    await monitoring();
    expect(init).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
  });

  test("[MON-004] s DSN se SDK inicializuje s prostředím a tunelem, uživatel jen s ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ dsn: "https://k@h.example.cz/1", environment: "staging" })),
    );
    const { identifyClientUser, monitoring } = await import("@/lib/monitoring-client");
    await monitoring();
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://k@h.example.cz/1",
        environment: "staging",
        tunnel: "/api/monitoring",
      }),
    );
    identifyClientUser("u1");
    await monitoring();
    await Promise.resolve();
    expect(setUser).toHaveBeenCalledWith({ id: "u1" });
  });
});
