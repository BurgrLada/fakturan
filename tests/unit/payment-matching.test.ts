import { describe, expect, test } from "vitest";
import {
  autoMatchAllowed,
  matchNotice,
  normalizeSymbol,
  QUEUE_REASONS,
  type MatchCandidate,
  type MatchableNotice,
  type QueueReason,
} from "@/lib/payment-matching";

const ACCOUNT = "acc-1";
const notice = (over: Partial<MatchableNotice> = {}): MatchableNotice => ({
  variant: "en",
  authResult: "pass",
  amountMinor: 100_000,
  currency: "CZK",
  variableSymbol: "20260042",
  paidOn: "2026-10-30",
  ...over,
});
const candidate = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id: "inv-1",
  status: "sent",
  currency: "CZK",
  bankAccountId: null,
  variableSymbol: "20260042",
  totalMinor: 100_000,
  paidMinor: 0,
  manualPayments: [],
  ...over,
});
const match = (n: MatchableNotice, candidates: MatchCandidate[], autoAllowed = true) =>
  matchNotice(n, candidates, { autoAllowed, targetAccountId: ACCOUNT, today: "2026-11-01" });

describe("normalizeSymbol", () => {
  test("úvodní nuly ve VS se srovnají", () => {
    expect(normalizeSymbol("0020260042")).toBe("20260042");
    expect(normalizeSymbol("20260042")).toBe("20260042");
    expect(normalizeSymbol("10")).toBe("10");
    expect(normalizeSymbol(" 007 ")).toBe("7");
  });

  test("prázdný a nulový symbol není symbol", () => {
    expect(normalizeSymbol(null)).toBeNull();
    expect(normalizeSymbol("")).toBeNull();
    expect(normalizeSymbol("  ")).toBeNull();
    expect(normalizeSymbol("0000")).toBeNull();
  });
});

describe("autoMatchAllowed", () => {
  test.each([
    ["en", "pass", true, true],
    ["en", "pass", false, true],
    ["en", "none", false, true],
    ["en", "none", true, false],
    ["en", "fail", false, false],
    ["en", "fail", true, false],
    ["cs_block", "pass", false, false],
    ["cs_sentence", "pass", false, false],
    ["cs_block", "none", false, false],
  ] as const)("%s %s s potvrzením %s dá %s", (variant, auth, confirmation, expected) => {
    expect(autoMatchAllowed(variant, auth, confirmation)).toBe(expected);
  });
});

describe("matchNotice", () => {
  test("[BNK-008] shoda VS, částky a měny na otevřené faktuře spáruje", () => {
    expect(match(notice(), [candidate()])).toEqual({ result: "match", invoiceId: "inv-1" });
  });

  test("[BNK-008] dílčí zbytek se páruje proti amountDue", () => {
    const partly = candidate({ status: "partially_paid", totalMinor: 300_000, paidMinor: 200_000 });
    expect(match(notice(), [partly])).toEqual({ result: "match", invoiceId: "inv-1" });
    expect(match(notice({ amountMinor: 300_000 }), [partly])).toMatchObject({ reason: "amount" });
  });

  test("[BNK-008] vystavená faktura a úvodní nuly na obou stranách se spárují", () => {
    const issued = candidate({ status: "issued", variableSymbol: "0020260042" });
    expect(match(notice({ variableSymbol: "020260042" }), [issued])).toMatchObject({
      result: "match",
    });
  });

  test("účet dokladu shodný s cílovým účtem spáruje", () => {
    expect(match(notice(), [candidate({ bankAccountId: ACCOUNT })])).toMatchObject({
      result: "match",
    });
  });

  test("stejný VS faktury a zálohy rozhodne částka, při shodě jde do fronty", () => {
    const invoice = candidate({ id: "inv" });
    const advance = candidate({ id: "adv", totalMinor: 50_000 });
    expect(match(notice(), [invoice, advance])).toEqual({ result: "match", invoiceId: "inv" });
    expect(match(notice(), [invoice, { ...advance, totalMinor: 100_000 }])).toEqual({
      result: "queue",
      reason: "multiple",
      invoiceIds: ["inv", "adv"],
    });
  });

  test("uhrazený doklad se stejným VS otevřenou fakturu nepřebije", () => {
    const paid = candidate({ id: "paid", status: "paid", paidMinor: 100_000 });
    expect(match(notice(), [paid, candidate()])).toEqual({ result: "match", invoiceId: "inv-1" });
  });

  test("dvě shody, z nichž jedna je na jiném účtu, rozhodne účet", () => {
    const other = candidate({ id: "other", bankAccountId: "acc-2" });
    expect(match(notice(), [other, candidate()])).toEqual({ result: "match", invoiceId: "inv-1" });
  });

  test("kandidát s jiným VS se nepočítá", () => {
    expect(match(notice(), [candidate({ variableSymbol: "111" })])).toEqual({
      result: "queue",
      reason: "unknown_vs",
      invoiceIds: [],
    });
    expect(match(notice(), [candidate({ variableSymbol: null })])).toMatchObject({
      reason: "unknown_vs",
    });
  });

  test("prozatímní varianta se nespáruje ani s povolením volajícího", () => {
    const czech = notice({ variant: "cs_block" });
    expect(match(czech, [candidate()], true)).toEqual({
      result: "queue",
      reason: "provisional",
      invoiceIds: ["inv-1"],
    });
    expect(match(notice({ variant: "cs_sentence" }), [candidate()], true)).toMatchObject({
      reason: "provisional",
    });
  });

  test("neprošlá kontrola se nespáruje ani s povolením volajícího", () => {
    expect(match(notice({ authResult: "fail" }), [candidate()], true)).toMatchObject({
      result: "queue",
      reason: "auth_failed",
    });
    expect(
      match(notice({ authResult: "fail", variant: "cs_block" }), [candidate()], true),
    ).toMatchObject({ reason: "auth_failed" });
  });

  test("uzavřený doklad se při zablokování nenabízí", () => {
    const paid = candidate({ status: "paid", paidMinor: 100_000 });
    expect(match(notice(), [paid], false)).toEqual({
      result: "queue",
      reason: "unverified",
      invoiceIds: [],
    });
  });

  const scenarios: Record<Exclude<QueueReason, "undone" | "conflict">, () => unknown> = {
    unknown_vs: () => match(notice(), []),
    no_vs: () => match(notice({ variableSymbol: null }), [candidate({ variableSymbol: null })]),
    amount: () => match(notice({ amountMinor: 1 }), [candidate()]),
    currency: () => match(notice({ currency: "EUR" }), [candidate()]),
    multiple: () => match(notice(), [candidate(), candidate({ id: "inv-2" })]),
    other_account: () => match(notice(), [candidate({ bankAccountId: "acc-2" })]),
    closed: () => match(notice(), [candidate({ status: "paid", paidMinor: 100_000 })]),
    provisional: () => match(notice({ variant: "cs_block" }), [candidate()], false),
    unverified: () => match(notice({ authResult: "none" }), [candidate()], false),
    auth_failed: () => match(notice({ authResult: "fail" }), [candidate()], false),
    manual_duplicate: () =>
      match(notice(), [
        candidate({ manualPayments: [{ amountMinor: 100_000, paidOn: "2026-10-30" }] }),
      ]),
    future_date: () => match(notice({ paidOn: "2026-11-02" }), [candidate()]),
  };

  test.each(QUEUE_REASONS.filter((reason) => reason !== "undone" && reason !== "conflict"))(
    "[BNK-010] důvod %s jde do fronty bez platby",
    (reason) => {
      expect(scenarios[reason]()).toMatchObject({ result: "queue", reason });
    },
  );

  test("fronta nabízí doklady z posledního splněného kroku", () => {
    const invoiceIds = (n: MatchableNotice, c: MatchCandidate[]) =>
      (match(n, c) as { invoiceIds: string[] }).invoiceIds;
    const paid = candidate({ id: "p", status: "paid", paidMinor: 100_000 });
    const euro = candidate({ id: "e", currency: "EUR" });
    const czk = candidate({ id: "c", totalMinor: 7 });
    const foreign = candidate({ id: "f", bankAccountId: "acc-2" });

    expect(invoiceIds(notice(), [paid])).toEqual(["p"]);
    expect(invoiceIds(notice(), [euro, paid])).toEqual(["e"]);
    expect(invoiceIds(notice(), [euro, czk, paid])).toEqual(["c"]);
    expect(invoiceIds(notice(), [foreign, czk])).toEqual(["f"]);
  });

  test("ruční platba jiné částky nebo data párování nezastaví", () => {
    const other = [
      { amountMinor: 100_000, paidOn: "2026-10-29" },
      { amountMinor: 99_999, paidOn: "2026-10-30" },
    ];
    expect(match(notice(), [candidate({ manualPayments: other })])).toMatchObject({
      result: "match",
    });
  });

  test("ruční platba se stejnou částkou a datem nabídne ten doklad", () => {
    const recorded = [{ amountMinor: 100_000, paidOn: "2026-10-30" }];
    expect(match(notice(), [candidate({ manualPayments: recorded })])).toEqual({
      result: "queue",
      reason: "manual_duplicate",
      invoiceIds: ["inv-1"],
    });
  });

  test("avízo s dnešním datem se páruje, budoucí nabídne otevřené doklady", () => {
    expect(match(notice({ paidOn: "2026-11-01" }), [candidate()])).toMatchObject({
      result: "match",
    });
    expect(match(notice({ paidOn: "2026-11-02" }), [candidate()])).toEqual({
      result: "queue",
      reason: "future_date",
      invoiceIds: ["inv-1"],
    });
  });

  test("bez VS se nic nenabízí", () => {
    expect(match(notice({ variableSymbol: "000" }), [candidate({ variableSymbol: "0" })])).toEqual({
      result: "queue",
      reason: "no_vs",
      invoiceIds: [],
    });
  });
});
