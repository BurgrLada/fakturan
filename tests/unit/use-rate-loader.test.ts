// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const action = vi.hoisted(() => ({ loadRateAction: vi.fn() }));
vi.mock("@/app/(app)/faktury/actions", () => action);

import { useRateLoader } from "@/components/invoices/use-rate-loader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = { enabled?: boolean; date: string };
const results: unknown[] = [];
const onExpired = vi.fn();
let root: Root;
let reload: () => void;

function Probe({ enabled = true, date }: Props) {
  reload = useRateLoader({
    enabled,
    currency: "EUR",
    date,
    onResult: (result) => results.push(result),
    onExpired,
  });
  return null;
}

const show = (props: Props) =>
  act(async () => {
    root.render(createElement(Probe, props));
  });
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(400)));
const rate = (rateMicros: number) => ({
  rateMicros,
  source: "cnb",
  listDate: "2026-10-30",
  reference: rateMicros,
});

beforeEach(() => {
  vi.useFakeTimers();
  results.length = 0;
  onExpired.mockReset();
  action.loadRateAction.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("načtení kurzu", () => {
  test("[FOR-003] pozdní odpověď na starý dotaz se zahodí", async () => {
    let finishOld: (reply: unknown) => void = () => undefined;
    action.loadRateAction.mockImplementationOnce(
      () => new Promise((resolve) => (finishOld = resolve)),
    );
    action.loadRateAction.mockResolvedValueOnce({ ok: true, rate: rate(25_000_000) });

    await show({ date: "2026-10-29" });
    await settle();
    await show({ date: "2026-10-30" });
    await settle();
    await act(async () => finishOld({ ok: true, rate: rate(24_000_000) }));

    expect(results).toEqual([rate(25_000_000)]);
  });

  test("[FOR-004] selhání akce znamená žádný kurz", async () => {
    action.loadRateAction.mockRejectedValueOnce(new Error("offline"));
    await show({ date: "2026-10-30" });
    await settle();
    expect(results).toEqual([null]);

    action.loadRateAction.mockResolvedValueOnce({ ok: false, expired: true, error: "x" });
    act(() => reload());
    await settle();
    expect(results).toEqual([null, null]);
    expect(onExpired).toHaveBeenCalledOnce();
  });

  test("[FOR-003] vypnutý se neptá a rychlé změny data spojí do jednoho dotazu", async () => {
    await show({ enabled: false, date: "2026-10-28" });
    await settle();
    expect(action.loadRateAction).not.toHaveBeenCalled();

    action.loadRateAction.mockResolvedValue({ ok: true, rate: null });
    await show({ date: "2026-10-29" });
    await show({ date: "2026-10-30" });
    await settle();
    expect(action.loadRateAction).toHaveBeenCalledExactlyOnceWith({
      currency: "EUR",
      date: "2026-10-30",
    });
  });
});
