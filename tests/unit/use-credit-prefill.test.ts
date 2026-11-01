// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const action = vi.hoisted(() => ({ creditPreviewAction: vi.fn() }));
vi.mock("@/app/(app)/faktury/actions", () => action);

import { useCreditPrefill } from "@/components/invoices/use-credit-prefill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = { amountMinor: number | null; paidOn: string | null; invoiceId?: string };
let latest: { value: string; prefilled: boolean; typed: () => void };
let root: Root;

function Probe(props: Props) {
  const [value, setValue] = useState("");
  const { prefilled, typed } = useCreditPrefill({
    enabled: true,
    invoiceId: props.invoiceId ?? "i1",
    currency: "USD",
    amountMinor: props.amountMinor,
    paidOn: props.paidOn,
    onValue: setValue,
  });
  latest = { value, prefilled, typed };
  return null;
}

const show = (props: Props) =>
  act(async () => {
    root.render(createElement(Probe, props));
  });
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(400)));

beforeEach(() => {
  vi.useFakeTimers();
  action.creditPreviewAction.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("předvyplnění připsané částky", () => {
  test("[PAY-006] odpověď s kurzem vyplní pole a označí ho jako předvyplněné", async () => {
    action.creditPreviewAction.mockResolvedValue({ ok: true, preview: { creditedMinor: 9_200 } });
    await show({ amountMinor: 10_000, paidOn: "2026-10-30" });
    await settle();

    expect(latest).toMatchObject({ value: "92,00", prefilled: true });
  });

  test("[PAY-006] nová odpověď bez kurzu smaže dříve předvyplněnou hodnotu", async () => {
    action.creditPreviewAction.mockResolvedValueOnce({
      ok: true,
      preview: { creditedMinor: 9_200 },
    });
    await show({ amountMinor: 10_000, paidOn: "2026-10-30" });
    await settle();
    action.creditPreviewAction.mockResolvedValueOnce({ ok: true, preview: null });
    await show({ amountMinor: 10_000, paidOn: "2026-10-29" });
    await settle();

    expect(latest).toMatchObject({ value: "", prefilled: false });
  });

  test("[PAY-006] selhání dotazu smaže dříve předvyplněnou hodnotu", async () => {
    action.creditPreviewAction.mockResolvedValueOnce({
      ok: true,
      preview: { creditedMinor: 9_200 },
    });
    await show({ amountMinor: 10_000, paidOn: "2026-10-30" });
    await settle();
    action.creditPreviewAction.mockRejectedValueOnce(new Error("síť"));
    await show({ amountMinor: 20_000, paidOn: "2026-10-30" });
    await settle();
    expect(latest).toMatchObject({ value: "", prefilled: false });

    action.creditPreviewAction.mockResolvedValueOnce({ ok: false, error: "x" });
    await show({ amountMinor: 30_000, paidOn: "2026-10-30" });
    await settle();
    expect(latest.value).toBe("");
  });

  test("[PAY-006] chyba bez dřívějšího předvyplnění pole nezasáhne", async () => {
    action.creditPreviewAction.mockRejectedValue(new Error("síť"));
    await show({ amountMinor: 10_000, paidOn: "2026-10-30" });
    await settle();

    expect(latest).toMatchObject({ value: "", prefilled: false });
  });

  test("[PAY-006] smazaná částka vymaže předvyplněnou hodnotu bez dotazu", async () => {
    action.creditPreviewAction.mockResolvedValue({ ok: true, preview: { creditedMinor: 9_200 } });
    await show({ amountMinor: 10_000, paidOn: "2026-10-30" });
    await settle();
    action.creditPreviewAction.mockClear();
    await show({ amountMinor: null, paidOn: "2026-10-30" });
    await settle();

    expect(latest).toMatchObject({ value: "", prefilled: false });
    expect(action.creditPreviewAction).not.toHaveBeenCalled();
  });

  test("[PAY-006] ruční zásah ponechá pole a pozdější odpověď ho nepřepíše ani nesmaže", async () => {
    action.creditPreviewAction.mockResolvedValueOnce({
      ok: true,
      preview: { creditedMinor: 9_200 },
    });
    await show({ amountMinor: 10_000, paidOn: "2026-10-30" });
    await settle();
    await act(async () => latest.typed());
    action.creditPreviewAction.mockResolvedValue({ ok: true, preview: null });
    await show({ amountMinor: 11_000, paidOn: "2026-10-30" });
    await settle();

    expect(latest.value).toBe("92,00");
    expect(latest.prefilled).toBe(false);
  });

  test("[PAY-006] odpověď na starší dotaz se zahodí", async () => {
    let first: (reply: unknown) => void = () => {};
    action.creditPreviewAction.mockReturnValueOnce(new Promise((resolve) => (first = resolve)));
    await show({ amountMinor: 10_000, paidOn: "2026-10-30" });
    await settle();
    action.creditPreviewAction.mockResolvedValueOnce({
      ok: true,
      preview: { creditedMinor: 5_000 },
    });
    await show({ amountMinor: 20_000, paidOn: "2026-10-30" });
    await settle();
    await act(async () => first({ ok: true, preview: { creditedMinor: 1 } }));

    expect(latest.value).toBe("50,00");
  });
});
